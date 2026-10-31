import http from 'node:http';
import { bearerToken } from './clients.js';
import { ApiError } from './params.js';
import { matchRoute } from './router.js';

// Serveur HTTP de l'API. Routes et authentification sont injectées : le
// serveur se teste sans base.
//
// Une route : { method, path, scope, handler } compilée par compileRoute ;
// scope null (public), 'read' (tout client actif) ou 'admin'.

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

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
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    throw new ApiError(400, 'bad_request', 'Corps JSON invalide');
  }
}

const sendError = (res, err, headers) =>
  send(res, err.status, { error: { code: err.code, message: err.message } }, headers);

export function createApiServer({ routes, authenticate, corsOrigins = [], log = () => {} }) {
  return http.createServer(async (req, res) => {
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

    try {
      const url = new URL(req.url, 'http://localhost');
      let match;
      try {
        match = matchRoute(routes, req.method, url.pathname);
      } catch {
        throw new ApiError(400, 'bad_request', 'Chemin mal encodé');
      }
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
      if (route.scope) {
        client = await authenticate(bearerToken(req.headers.authorization));
        if (!client) {
          return sendError(res, new ApiError(401, 'unauthorized', 'Jeton absent, invalide ou révoqué'), {
            ...cors,
            'WWW-Authenticate': 'Bearer',
          });
        }
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
      log(`Erreur interne : ${err.stack ?? err.message}`);
      return sendError(res, new ApiError(500, 'internal_error', 'Erreur interne'), cors);
    }
  });
}
