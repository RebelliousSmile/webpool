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
        match = matchRoute(routes, req.method === 'OPTIONS' ? 'GET' : req.method, url.pathname);
      } catch {
        throw new ApiError(400, 'bad_request', 'Chemin mal encodé');
      }
      if (!match) throw new ApiError(404, 'not_found', 'Route inconnue');
      if (match.allowed) {
        return sendError(res, new ApiError(405, 'method_not_allowed', 'Méthode non autorisée'), {
          ...cors,
          Allow: [...new Set(match.allowed)].join(', '),
        });
      }

      // Prévol CORS : sans authentification, le navigateur n'envoie pas le jeton.
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...BASE_HEADERS,
          ...cors,
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Allow-Headers': 'Authorization',
          'Access-Control-Max-Age': '600',
        });
        return res.end();
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

      const result = await route.handler({ client, params, query: url.searchParams });
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
