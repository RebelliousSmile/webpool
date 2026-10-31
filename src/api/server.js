import http from 'node:http';
import { config } from '../config.js';
import { bearerToken } from './clients.js';
import { ApiError } from './params.js';
import { createRateLimiter } from './rateLimit.js';
import { matchRoute } from './router.js';

// Serveur HTTP de l'API. Routes, authentification et limitation de débit sont
// injectées : le serveur se teste sans base.
//
// Une route : { method, path, scope, handler } compilée par compileRoute ;
// scope null (public), 'read' (tout client actif) ou 'admin'.

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

// Délais du serveur : une connexion lente ne garde pas un emplacement indéfiniment.
export const REQUEST_TIMEOUT_MS = 30_000;
export const HEADERS_TIMEOUT_MS = 15_000;
export const KEEP_ALIVE_TIMEOUT_MS = 5_000;

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

// Octet NUL : PostgreSQL le refuse dans un texte (erreur 22021), il n'a rien à
// faire dans un chemin, un paramètre ou un corps. Refusé avant les handlers.
const nulError = () => new ApiError(400, 'bad_request', 'Octet NUL (\\u0000) interdit');

export function containsNul(value) {
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some(containsNul);
  if (value && typeof value === 'object') return Object.entries(value).some(([k, v]) => containsNul(k) || containsNul(v));
  return false;
}

// Erreurs PostgreSQL d'un texte invalide (octet NUL, séquence mal encodée) : la
// faute est dans la requête du client, pas dans le serveur.
const PG_BAD_TEXT = new Set(['22021', '22P05']);

// Corps JSON d'un POST : borné, et seulement en application/json (un formulaire
// HTML d'un autre site ne peut pas l'envoyer sans prévol).
export const MAX_BODY_BYTES = 8192;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new ApiError(415, 'unsupported_media_type', 'Corps attendu en application/json');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, 'payload_too_large', `Corps limité à ${MAX_BODY_BYTES} octets`);
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    throw new ApiError(400, 'bad_request', 'Corps JSON invalide');
  }
  if (containsNul(body)) throw nulError();
  return body;
}

const sendError = (res, err, headers) =>
  send(res, err.status, { error: { code: err.code, message: err.message } }, headers);

// Adresse du client : derrière un proxy de confiance (trustProxy), la dernière
// entrée de X-Forwarded-For, celle que le proxy a ajoutée ; sinon la socket.
export function clientAddress(req, trustProxy = false) {
  const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1).trim() : '';
  return forwarded || req.socket.remoteAddress || '-';
}

export function createApiServer({
  routes,
  authenticate,
  corsOrigins = [],
  log = () => {},
  // { take(key), peek(key) } : voir rateLimit.js ; par défaut WEBPOOL_API_RATE_LIMIT par minute
  rateLimiter = createRateLimiter({ limit: config.apiRateLimit }),
  maxConnections = config.apiMaxConnections,
  trustProxy = config.apiTrustProxy,
}) {
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let client = null;
    res.on('finish', () => {
      log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms ${client?.name ?? '-'}`);
    });

    const cors = {};
    const origin = req.headers.origin;
    if (origin && corsOrigins.includes(origin)) {
      Object.assign(cors, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
    }

    const ip = clientAddress(req, trustProxy);
    const limited = (verdict) => {
      if (verdict.ok) return false;
      sendError(res, new ApiError(429, 'rate_limited', `Trop de requêtes : réessayer dans ${verdict.retryAfter} s`), {
        ...cors,
        'Retry-After': String(verdict.retryAfter),
      });
      return true;
    };

    try {
      if (/%00/i.test(req.url) || req.url.includes('\u0000')) throw nulError();
      const url = new URL(req.url, 'http://localhost');
      let match;
      try {
        match = matchRoute(routes, req.method, url.pathname);
      } catch {
        throw new ApiError(400, 'bad_request', 'Chemin mal encodé');
      }
      // Sans jeton (route publique, prévol, chemin inconnu) : limitation par IP.
      if (!match?.route?.scope && limited(rateLimiter.take(`ip:${ip}`))) return undefined;
      if (!match) throw new ApiError(404, 'not_found', 'Route inconnue');

      // Prévol CORS : sans authentification, le navigateur n'envoie pas le jeton.
      if (req.method === 'OPTIONS' && match.allowed) {
        res.writeHead(204, {
          ...BASE_HEADERS,
          ...cors,
          'Access-Control-Allow-Methods': [...new Set(match.allowed)].join(', '),
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '600',
        });
        return res.end();
      }
      if (match.allowed) {
        return sendError(res, new ApiError(405, 'method_not_allowed', 'Méthode non autorisée'), {
          ...cors,
          Allow: [...new Set(match.allowed)].join(', '),
        });
      }

      const { route, params } = match;
      if (Object.values(params).some(containsNul) || [...url.searchParams].some((pair) => containsNul(pair))) {
        throw nulError();
      }
      if (route.scope) {
        // Les échecs d'authentification sont comptés par IP : pas de jetons
        // essayés en rafale, et pas de requête en base au-delà de la limite.
        if (limited(rateLimiter.peek(`auth:${ip}`))) return undefined;
        client = await authenticate(bearerToken(req.headers.authorization));
        if (!client) {
          rateLimiter.take(`auth:${ip}`);
          return sendError(res, new ApiError(401, 'unauthorized', 'Jeton absent, invalide ou révoqué'), {
            ...cors,
            'WWW-Authenticate': 'Bearer',
          });
        }
        if (limited(rateLimiter.take(`client:${client.id ?? client.name}`))) return undefined;
        if (route.scope === 'admin' && client.scope !== 'admin') {
          throw new ApiError(403, 'forbidden', 'Réservé aux clients admin');
        }
      }

      const body = BODY_METHODS.has(req.method) ? await readJson(req) : undefined;
      const result = await route.handler({ client, params, query: url.searchParams, body });
      if (result.raw !== undefined) {
        return send(res, 200, result.raw, {
          ...cors,
          'Content-Type': result.contentType,
          ...result.headers,
          ...(result.filename ? { 'Content-Disposition': `attachment; filename="${result.filename}"` } : {}),
        });
      }
      return send(res, result.status ?? 200, result.body, cors);
    } catch (err) {
      if (err instanceof ApiError) return sendError(res, err, cors);
      // Dernier rempart : un texte que PostgreSQL refuse vient de la requête.
      if (PG_BAD_TEXT.has(err?.code)) return sendError(res, new ApiError(400, 'bad_request', 'Caractère invalide dans la requête'), cors);
      log(`Erreur interne : ${err.stack ?? err.message}`);
      return sendError(res, new ApiError(500, 'internal_error', 'Erreur interne'), cors);
    }
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.maxConnections = maxConnections;
  return server;
}
