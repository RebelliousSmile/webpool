import fs from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bearerToken, generateToken, hashToken } from '../src/api/clients.js';
import { facetParams, likePattern, pageParams, boolParam, enumParam, ApiError } from '../src/api/params.js';
import { compileRoute, matchRoute } from '../src/api/router.js';
import { createRateLimiter } from '../src/api/rateLimit.js';
import { clientAddress, containsNul, createApiServer } from '../src/api/server.js';
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
    { path: '/pg/:code', scope: null, handler: async ({ params }) => { throw Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: params.code }); } },
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

  describe('octet NUL', () => {
    const expectNul = async (res) => {
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('bad_request');
    };
    // Le test /boom a déjà journalisé une erreur interne : seul ce qui suit compte.
    let from = 0;
    beforeEach(() => {
      from = logs.length;
    });
    const noStack = () => expect(logs.slice(from).some((l) => l.startsWith('Erreur interne'))).toBe(false);

    it('refuse %00 dans le chemin', async () => {
      await expectNul(await get('/echo/a%00b', 'tok-read'));
      noStack();
    });

    it('refuse %00 dans un paramètre, nom ou valeur, même sur une route publique', async () => {
      await expectNul(await get('/echo/a?q=x%00', 'tok-read'));
      await expectNul(await get('/echo/a?q%00=x', 'tok-read'));
      await expectNul(await get('/open?x=%00'));
      noStack();
    });

    it('refuse \\u0000 dans le corps JSON, en valeur, en clé ou imbriqué', async () => {
      const post = (body) =>
        fetch(`${base}/echo/a`, { method: 'POST', headers: { Authorization: 'Bearer tok-read', 'Content-Type': 'application/json' }, body });
      await expectNul(await post(JSON.stringify({ q: 'a\u0000b' })));
      await expectNul(await post(JSON.stringify({ 'k\u0000': 1 })));
      await expectNul(await post(JSON.stringify({ list: [{ deep: ['\u0000'] }] })));
      expect((await post(JSON.stringify({ q: 'a\\u0000b' }))).status).toBe(201); // antislash littéral : permis
      noStack();
    });

    it('traduit les erreurs PostgreSQL 22021 et 22P05 en 400, sans pile', async () => {
      await expectNul(await get('/pg/22021'));
      await expectNul(await get('/pg/22P05'));
      noStack();
      expect((await get('/pg/23505')).status).toBe(500);
    });
  });

  it('fixe délais et plafond de connexions', () => {
    expect(server.requestTimeout).toBe(30_000);
    expect(server.headersTimeout).toBe(15_000);
    expect(server.keepAliveTimeout).toBe(5_000);
    expect(server.maxConnections).toBe(256);
  });
});

describe('containsNul', () => {
  it('cherche dans chaînes, tableaux, clés et objets imbriqués', () => {
    expect(containsNul('a\u0000')).toBe(true);
    expect(containsNul({ a: [1, { b: 'x\u0000' }] })).toBe(true);
    expect(containsNul({ ['\u0000']: 1 })).toBe(true);
    expect(containsNul({ a: [1, null, true, 'ok'] })).toBe(false);
    expect(containsNul(null)).toBe(false);
  });
});

describe('clientAddress', () => {
  const req = (xff) => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: '10.0.0.9' } });

  it('ignore X-Forwarded-For sans proxy de confiance', () => {
    expect(clientAddress(req('1.2.3.4'))).toBe('10.0.0.9');
  });

  it("prend la dernière entrée, ajoutée par le proxy, s'il est de confiance", () => {
    expect(clientAddress(req('6.6.6.6, 1.2.3.4'), true)).toBe('1.2.3.4');
    expect(clientAddress(req(''), true)).toBe('10.0.0.9');
    expect(clientAddress({ headers: {}, socket: {} })).toBe('-');
  });
});

describe('createRateLimiter', () => {
  it('fenêtre glissante : refuse au-delà de la limite, puis libère', () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => t });
    expect(rl.take('a').ok).toBe(true);
    t = 30_000;
    expect(rl.take('a').ok).toBe(true);
    expect(rl.take('a')).toEqual({ ok: false, retryAfter: 30 });
    expect(rl.take('b').ok).toBe(true); // clés indépendantes
    t = 60_000; // le premier appel sort de la fenêtre
    expect(rl.peek('a').ok).toBe(true);
    expect(rl.take('a').ok).toBe(true);
    expect(rl.take('a')).toEqual({ ok: false, retryAfter: 30 });
  });

  it('oublie les clés inactives', () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 5, windowMs: 1000, now: () => t });
    for (const k of ['a', 'b', 'c']) rl.take(k);
    expect(rl.size()).toBe(3);
    t = 5000;
    rl.take('d');
    expect(rl.size()).toBe(1);
  });

  it('limite 0 : rien n’est limité', () => {
    const rl = createRateLimiter({ limit: 0 });
    for (let i = 0; i < 10; i += 1) expect(rl.take('a').ok).toBe(true);
    expect(rl.peek('a').ok).toBe(true);
  });
});

describe('serveur — limitation de débit', () => {
  const clients = { 'tok-a': { id: 1, name: 'a', scope: 'read' }, 'tok-b': { id: 2, name: 'b', scope: 'read' } };
  const routesRl = [
    { path: '/open', scope: null, handler: async () => ({ body: { ok: true } }) },
    { path: '/me', scope: 'read', handler: async ({ client }) => ({ body: { who: client.name } }) },
  ].map((r) => compileRoute({ method: 'GET', ...r }));
  let server;
  let base;
  let authCalls = 0;

  beforeAll(async () => {
    server = createApiServer({
      routes: routesRl,
      authenticate: async (token) => ((authCalls += 1), clients[token] ?? null),
      rateLimiter: createRateLimiter({ limit: 3, windowMs: 60_000 }),
      maxConnections: 7,
      corsOrigins: ['https://datapool.test'],
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  const get = (path, token) =>
    fetch(`${base}${path}`, { headers: { Origin: 'https://datapool.test', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });

  it('prend maxConnections injecté', () => {
    expect(server.maxConnections).toBe(7);
  });

  it('limite par jeton : 429 rate_limited avec Retry-After, les autres jetons passent', async () => {
    for (let i = 0; i < 3; i += 1) expect((await get('/me', 'tok-a')).status).toBe(200);
    const res = await get('/me', 'tok-a');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://datapool.test');
    expect((await res.json()).error.code).toBe('rate_limited');
    expect((await get('/me', 'tok-b')).status).toBe(200);
  });

  it('limite les routes publiques par IP', async () => {
    for (let i = 0; i < 3; i += 1) expect((await get('/open')).status).toBe(200);
    const res = await get('/open');
    expect(res.status).toBe(429);
    expect((await get('/nope')).status).toBe(429); // chemin inconnu : même compteur d'IP
    expect((await get('/me', 'tok-b')).status).toBe(200); // un jeton valide a son propre compteur
  });

  it("compte les échecs d'authentification par IP, puis n'interroge plus la base", async () => {
    for (let i = 0; i < 3; i += 1) expect((await get('/me', 'faux')).status).toBe(401);
    const before = authCalls;
    expect((await get('/me', 'faux')).status).toBe(429);
    expect(authCalls).toBe(before);
  });
});
