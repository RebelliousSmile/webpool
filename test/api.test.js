import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearerToken, generateToken, hashToken } from '../src/api/clients.js';
import { facetParams, likePattern, pageParams, boolParam, enumParam, ApiError } from '../src/api/params.js';
import { compileRoute, matchRoute } from '../src/api/router.js';
import { createApiServer } from '../src/api/server.js';
import { OPENAPI_PATH, routes } from '../src/api/index.js';

const qs = (s) => new URLSearchParams(s);

describe('jetons', () => {
  it('génère des jetons distincts, préfixés, et une empreinte stable', () => {
    const a = generateToken();
    expect(a).toMatch(/^wp_[\w-]{43}$/);
    expect(generateToken()).not.toBe(a);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lit l'en-tête Authorization Bearer", () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer  abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('paramètres', () => {
  it('pagine avec des bornes', () => {
    expect(pageParams(qs(''))).toEqual({ limit: 50, offset: 0 });
    expect(pageParams(qs('limit=10&offset=20'))).toEqual({ limit: 10, offset: 20 });
    expect(() => pageParams(qs('limit=0'))).toThrow(ApiError);
    expect(() => pageParams(qs('limit=501'))).toThrow(/entre 1 et 500/);
    expect(() => pageParams(qs('offset=-1'))).toThrow(/entier/);
  });

  it('valide énumérations et booléens', () => {
    expect(enumParam(qs('s=a'), 's', ['a'])).toBe('a');
    expect(enumParam(qs(''), 's', ['a'])).toBeUndefined();
    expect(() => enumParam(qs('s=b'), 's', ['a'])).toThrow(/attendu : a/);
    expect(boolParam(qs('b=true'), 'b')).toBe(true);
    expect(boolParam(qs('b=0'), 'b')).toBe(false);
    expect(() => boolParam(qs('b=oui'), 'b')).toThrow(ApiError);
  });

  it('lit les facettes slug:valeur répétées', () => {
    expect(facetParams(qs('facet=lieu:kyoto&facet=annee:2025'))).toEqual([
      { slug: 'lieu', value: 'kyoto' },
      { slug: 'annee', value: '2025' },
    ]);
    expect(facetParams(qs('facet=url:https://x'))).toEqual([{ slug: 'url', value: 'https://x' }]);
    expect(() => facetParams(qs('facet=lieu'))).toThrow(/slug:valeur/);
    expect(() => facetParams(qs('facet=:x'))).toThrow(ApiError);
  });

  it("neutralise les jokers ILIKE", () => {
    expect(likePattern('50%_a\\b')).toBe('%50\\%\\_a\\\\b%');
  });
});

describe('routeur', () => {
  const table = [
    compileRoute({ method: 'GET', path: '/a/:slug' }),
    compileRoute({ method: 'GET', path: '/a/:slug/items' }),
  ];

  it('capture et décode les segments', () => {
    const m = matchRoute(table, 'GET', '/a/caf%C3%A9');
    expect(m.route.path).toBe('/a/:slug');
    expect(m.params).toEqual({ slug: 'café' });
    expect(matchRoute(table, 'GET', '/a/x/items').route.path).toBe('/a/:slug/items');
  });

  it('distingue chemin inconnu et méthode refusée', () => {
    expect(matchRoute(table, 'GET', '/b')).toBeNull();
    expect(matchRoute(table, 'GET', '/a/x/y')).toBeNull();
    expect(matchRoute(table, 'POST', '/a/x')).toEqual({ allowed: ['GET'] });
  });

  it('échappe les caractères spéciaux des motifs', () => {
    const [r] = [compileRoute({ method: 'GET', path: '/openapi.json' })];
    expect(matchRoute([r], 'GET', '/openapiXjson')).toBeNull();
  });
});

describe('openapi.json', () => {
  it('décrit exactement les routes servies', () => {
    const doc = JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf8'));
    const route = (p) => `/api/v1${p.replace(/\{(\w+)\}/g, ':$1')}`;
    const operations = Object.entries(doc.paths).flatMap(([p, ops]) =>
      Object.entries(ops).map(([method, op]) => ({ key: `${method.toUpperCase()} ${route(p)}`, op })),
    );
    expect(operations.map((o) => o.key).sort()).toEqual(routes.map((r) => `${r.method} ${r.path}`).sort());
    const publicOps = operations
      .filter(({ op }) => Array.isArray(op.security) && op.security.length === 0)
      .map((o) => o.key);
    expect(publicOps.sort()).toEqual(routes.filter((r) => !r.scope).map((r) => `${r.method} ${r.path}`).sort());
  });
});

describe('serveur', () => {
  const clients = { 'tok-admin': { id: 1, name: 'moi', scope: 'admin' }, 'tok-read': { id: 2, name: 'c', scope: 'read' } };
  const logs = [];
  const fakeRoutes = [
    { path: '/open', scope: null, handler: async () => ({ body: { ok: true } }) },
    { path: '/echo/:x', scope: 'read', handler: async ({ client, params, query }) => ({ body: { who: client.name, x: params.x, q: query.get('q') } }) },
    { path: '/admin', scope: 'admin', handler: async () => ({ body: { secret: true } }) },
    { path: '/raw', scope: null, handler: async () => ({ raw: 'a,b\n', contentType: 'text/csv', filename: 'p.csv' }) },
    { path: '/boom', scope: null, handler: async () => { throw new Error('détail interne'); } },
    { path: '/bad', scope: null, handler: async () => { throw new ApiError(400, 'bad_request', 'mauvais'); } },
    { path: '/echo/:x', method: 'POST', scope: 'read', handler: async ({ body }) => ({ status: 201, body: { got: body } }) },
    { path: '/item/:x', method: 'DELETE', scope: 'read', handler: async ({ params }) => ({ body: { deleted: params.x } }) },
  ].map((r) => compileRoute({ method: 'GET', ...r }));
  let server;
  let base;

  beforeAll(async () => {
    server = createApiServer({
      routes: fakeRoutes,
      authenticate: async (token) => clients[token] ?? null,
      corsOrigins: ['https://datapool.test'],
      log: (line) => logs.push(line),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  const get = (path, token, headers = {}) =>
    fetch(`${base}${path}`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });

  it('sert une route publique sans jeton', async () => {
    const res = await get('/open');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('exige un jeton valide', async () => {
    const res = await get('/echo/1');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect((await res.json()).error.code).toBe('unauthorized');
    expect((await get('/echo/1', 'faux')).status).toBe(401);
  });

  it('transmet client, paramètres et query au handler', async () => {
    const res = await get('/echo/a%20b?q=z', 'tok-read');
    expect(await res.json()).toEqual({ who: 'c', x: 'a b', q: 'z' });
    expect(logs.at(-1)).toMatch(/^GET \/echo\/a%20b\?q=z 200 \d+ms c$/);
  });

  it('réserve les routes admin', async () => {
    expect((await get('/admin', 'tok-read')).status).toBe(403);
    expect((await get('/admin', 'tok-admin')).status).toBe(200);
  });

  it('répond 404, 405 et 400 en JSON', async () => {
    const r404 = await get('/nope');
    expect(r404.status).toBe(404);
    expect((await r404.json()).error.code).toBe('not_found');
    const r405 = await fetch(`${base}/open`, { method: 'POST' });
    expect(r405.status).toBe(405);
    expect(r405.headers.get('allow')).toBe('GET');
    expect((await get('/echo/%E0', 'tok-read')).status).toBe(400);
    expect(await (await get('/bad')).json()).toEqual({ error: { code: 'bad_request', message: 'mauvais' } });
  });

  it("masque le détail d'une erreur interne", async () => {
    const res = await get('/boom');
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('détail interne');
    expect(logs.some((l) => l.includes('détail interne'))).toBe(true);
  });

  it('sert un contenu brut en pièce jointe', async () => {
    const res = await get('/raw');
    expect(res.headers.get('content-type')).toBe('text/csv');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="p.csv"');
    expect(await res.text()).toBe('a,b\n');
  });

  it('lit un corps JSON borné, en application/json seulement', async () => {
    const post = (body, type = 'application/json', token = 'tok-read') =>
      fetch(`${base}/echo/a`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body });
    const ok = await post(JSON.stringify({ q: 1 }));
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ got: { q: 1 } });
    expect((await post('{"q":', 'application/json')).status).toBe(400);
    expect((await post('q=1', 'application/x-www-form-urlencoded')).status).toBe(415);
    expect((await post(JSON.stringify({ q: 'x'.repeat(9000) }))).status).toBe(413);
    // l'authentification passe avant la lecture du corps
    expect((await post('{}', 'application/json', 'nope')).status).toBe(401);
    const del = await fetch(`${base}/item/3`, { method: 'DELETE', headers: { Authorization: 'Bearer tok-read' } });
    expect(await del.json()).toEqual({ deleted: '3' });
  });

  it('prévol : méthodes du chemin, en-têtes Authorization et Content-Type', async () => {
    const pre = await fetch(`${base}/echo/a`, { method: 'OPTIONS', headers: { Origin: 'https://datapool.test' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toBe('GET, POST');
    expect((await fetch(`${base}/item/3`, { method: 'OPTIONS' })).headers.get('access-control-allow-methods')).toBe('DELETE');
    expect((await fetch(`${base}/nope`, { method: 'OPTIONS' })).status).toBe(404);
  });

  it("n'autorise CORS que pour les origines configurées", async () => {
    const ok = await get('/open', null, { Origin: 'https://datapool.test' });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://datapool.test');
    const other = await get('/open', null, { Origin: 'https://evil.test' });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();

    const preflight = await fetch(`${base}/admin`, { method: 'OPTIONS', headers: { Origin: 'https://datapool.test' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toBe('Authorization, Content-Type');
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET');
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://datapool.test');
  });
});
