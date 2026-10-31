import fs from 'node:fs';
import path from 'node:path';
import { rootDir } from '../env.js';
import { authenticate } from './clients.js';
import * as h from './handlers.js';
import { compileRoute } from './router.js';
import { createApiServer } from './server.js';

// API HTTP de webpool (`webpool serve`), décrite par openapi.json. Elle lit le
// corpus et les pools ; elle n'écrit que les recherches payantes et leur grand livre.
export const OPENAPI_PATH = path.join(rootDir, 'openapi.json');

const openapi = async () => ({ raw: fs.readFileSync(OPENAPI_PATH, 'utf8'), contentType: 'application/json; charset=utf-8' });

export const routes = [
  { path: '/api/v1/health', scope: null, handler: h.health },
  { path: '/api/v1/openapi.json', scope: null, handler: openapi },
  // Lecture seule du cache, fichiers immuables : hors limitation de débit.
  { path: '/api/v1/media/:file', scope: null, unlimited: true, handler: h.getMedia },
  { path: '/api/v1/me', scope: 'read', handler: h.me },
  { path: '/api/v1/pools', scope: 'read', handler: h.listPools },
  { path: '/api/v1/pools/:slug', scope: 'read', handler: h.getPool },
  { path: '/api/v1/pools/:slug/items', scope: 'read', handler: h.listPoolItems },
  { path: '/api/v1/pools/:slug/export', scope: 'read', handler: h.exportVisiblePool },
  { path: '/api/v1/billing', scope: 'read', handler: h.billing },
  { path: '/api/v1/billing/entries', scope: 'read', handler: h.listBillingEntries },
  { path: '/api/v1/requests', scope: 'read', handler: h.listClientRequests },
  { path: '/api/v1/requests', method: 'POST', scope: 'read', handler: h.postRequest },
  { path: '/api/v1/requests/:id', method: 'DELETE', scope: 'read', handler: h.deleteRequest },
  { path: '/api/v1/communities/:slug/members', scope: 'read', handler: h.listCommunityMembers },
  { path: '/api/v1/communities/:slug/invitation', method: 'POST', scope: 'read', handler: h.acceptInvitation },
  { path: '/api/v1/communities/:slug/invitation', method: 'DELETE', scope: 'read', handler: h.declineInvitation },
  { path: '/api/v1/communities/:slug/membership', method: 'DELETE', scope: 'read', handler: h.leaveCommunityHandler },
  { path: '/api/v1/communities/:slug/members/:name', method: 'PUT', scope: 'read', handler: h.putCommunityMember },
  { path: '/api/v1/communities/:slug/members/:name', method: 'DELETE', scope: 'read', handler: h.deleteCommunityMember },
  { path: '/api/v1/admin/stats', scope: 'admin', handler: h.adminStats },
  { path: '/api/v1/admin/pools/:slug/export', scope: 'admin', handler: h.exportPool },
  { path: '/api/v1/admin/urls', scope: 'admin', handler: h.listUrls },
  { path: '/api/v1/admin/urls/:id', scope: 'admin', handler: h.getUrl },
  { path: '/api/v1/admin/themes', scope: 'admin', handler: h.listThemes },
  { path: '/api/v1/admin/facets', scope: 'admin', handler: h.listFacets },
  { path: '/api/v1/admin/domains', scope: 'admin', handler: h.listDomains },
  { path: '/api/v1/admin/queries', scope: 'admin', handler: h.listSearchQueries },
  { path: '/api/v1/admin/requests', scope: 'admin', handler: h.listAllRequests },
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
