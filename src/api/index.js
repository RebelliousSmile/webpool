import fs from 'node:fs';
import path from 'node:path';
import { rootDir } from '../env.js';
import { authenticate } from './clients.js';
import * as h from './handlers.js';
import { compileRoute } from './router.js';
import { createApiServer } from './server.js';

// API HTTP en lecture seule de webpool (`webpool serve`), décrite par openapi.json.
export const OPENAPI_PATH = path.join(rootDir, 'openapi.json');

const openapi = async () => ({ raw: fs.readFileSync(OPENAPI_PATH, 'utf8'), contentType: 'application/json; charset=utf-8' });

export const routes = [
  { path: '/api/v1/health', scope: null, handler: h.health },
  { path: '/api/v1/openapi.json', scope: null, handler: openapi },
  { path: '/api/v1/media/:file', scope: null, handler: h.getMedia },
  { path: '/api/v1/me', scope: 'read', handler: h.me },
  { path: '/api/v1/pools', scope: 'read', handler: h.listPools },
  { path: '/api/v1/pools/:slug', scope: 'read', handler: h.getPool },
  { path: '/api/v1/pools/:slug/items', scope: 'read', handler: h.listPoolItems },
  { path: '/api/v1/admin/stats', scope: 'admin', handler: h.adminStats },
  { path: '/api/v1/admin/pools/:slug/export', scope: 'admin', handler: h.exportPool },
  { path: '/api/v1/admin/urls', scope: 'admin', handler: h.listUrls },
  { path: '/api/v1/admin/urls/:id', scope: 'admin', handler: h.getUrl },
  { path: '/api/v1/admin/themes', scope: 'admin', handler: h.listThemes },
  { path: '/api/v1/admin/facets', scope: 'admin', handler: h.listFacets },
  { path: '/api/v1/admin/domains', scope: 'admin', handler: h.listDomains },
  { path: '/api/v1/admin/queries', scope: 'admin', handler: h.listSearchQueries },
  { path: '/api/v1/admin/runs', scope: 'admin', handler: h.listRuns },
].map((r) => compileRoute({ method: 'GET', ...r }));

// Démarre le serveur ; la promesse se résout à l'arrêt (SIGINT, SIGTERM).
export function serve({ port, host, corsOrigins, log = console.log }) {
  const server = createApiServer({ routes, authenticate, corsOrigins, log });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      log(`webpool API sur http://${host}:${server.address().port}/api/v1`);
      const stop = () => server.close(() => resolve());
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  });
}
