import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSchema, dbAvailable, dbRequired, dropSchema, resetData, writeTempJson } from './helpers.js';

const available = await dbAvailable();
if (!available && dbRequired()) {
  throw new Error('[integration] PostgreSQL injoignable alors que la suite est requise (CI ou WEBPOOL_IT_REQUIRED).');
}

describe.skipIf(!available)('API HTTP sur PostgreSQL', () => {
  let db;
  let server;
  let base;
  let admin;
  let reader;
  let clients;

  beforeAll(async () => {
    await createSchema();
    db = await import('../../src/db.js');
    await resetData((...a) => db.query(...a));
    clients = await import('../../src/api/clients.js');
    const { ingest } = await import('../../src/ingest/index.js');
    const { normalizePending } = await import('../../src/normalize/index.js');
    const { classifyPending } = await import('../../src/classify/index.js');
    const pools = await import('../../src/pools/index.js');
    const { qualifyDomain } = await import('../../src/domains/index.js');
    const { addQuery } = await import('../../src/explore/index.js');
    const { routes } = await import('../../src/api/index.js');
    const { createApiServer } = await import('../../src/api/server.js');

    const input = writeTempJson('serp.json', [
      { url: 'https://github.com/kohya-ss/sd-scripts', title: 'kohya LoRA training scripts' },
      { url: 'https://civitai.com/models?query=forest+lora', title: 'Forest LoRA models' },
      { url: 'https://example.com/lora-training-guide?utm_source=x', title: 'LoRA training guide 50% off' },
    ]);
    await ingest({ provider: 'file', searchQuery: 'forest lora', input });
    await normalizePending({ offline: true });
    await classifyPending({});
    await qualifyDomain({ domain: 'github.com', usage: 'libre' });
    await pools.createPool({ slug: 'lora', label: 'LoRA', definition: { theme: 'ia-generative', order: 'quality' } });
    await pools.refreshPool('lora');
    await pools.createPool({ slug: 'secret', label: 'Secret', definition: { theme: 'ia-generative', limit: 1 } });
    await pools.refreshPool('secret');
    await addQuery({ provider: 'brave', query: 'lora dataset', tags: ['lora'] });

    admin = await clients.addClient({ name: 'moi', scope: 'admin' });
    reader = await clients.addClient({ name: 'client-a', scope: 'read' });
    await clients.setPoolAccess({ name: 'client-a', slug: 'lora', granted: true });

    server = createApiServer({ routes, authenticate: clients.authenticate });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
  });

  afterAll(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    await db?.closePool();
    await dropSchema();
  });

  const get = async (path, who) => {
    const res = await fetch(`${base}${path}`, { headers: who ? { Authorization: `Bearer ${who.token}` } : {} });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, headers: res.headers, body: type.startsWith('application/json') ? await res.json() : await res.text() };
  };

  it('répond à health et sert openapi.json sans jeton', async () => {
    expect((await get('/health')).body).toEqual({ ok: true });
    expect((await get('/openapi.json')).body.openapi).toBe('3.1.0');
  });

  it('authentifie par jeton et refuse un jeton révoqué', async () => {
    expect((await get('/me', admin)).body).toEqual({ name: 'moi', scope: 'admin' });
    expect((await get('/me', reader)).body).toEqual({ name: 'client-a', scope: 'read' });
    const temp = await clients.addClient({ name: 'jetable' });
    expect((await get('/me', temp)).status).toBe(200);
    await clients.revokeClient({ name: 'jetable' });
    expect((await get('/me', temp)).status).toBe(401);
  });

  it('gère les clients : liste, accès aux pools, erreurs', async () => {
    const rows = await clients.listClients();
    expect(rows.map((c) => [c.name, c.scope, c.pools])).toEqual(
      expect.arrayContaining([
        ['client-a', 'read', ['lora']],
        ['moi', 'admin', []],
      ]),
    );
    await expect(clients.addClient({ name: 'moi' })).rejects.toThrow('Client existant : moi');
    await expect(clients.addClient({ name: 'x', scope: 'root' })).rejects.toThrow('--scope invalide');
    await expect(clients.revokeClient({ name: 'personne' })).rejects.toThrow('Client inconnu ou déjà révoqué');
    await expect(clients.setPoolAccess({ name: 'personne', slug: 'lora', granted: true })).rejects.toThrow('Client inconnu');
    await expect(clients.setPoolAccess({ name: 'client-a', slug: 'nope', granted: true })).rejects.toThrow('Pool inconnu');

    await clients.setPoolAccess({ name: 'client-a', slug: 'secret', granted: true });
    expect((await get('/pools/secret', reader)).status).toBe(200);
    await clients.setPoolAccess({ name: 'client-a', slug: 'secret', granted: false });
    expect((await get('/pools/secret', reader)).status).toBe(404);
    expect(await clients.authenticate(null)).toBeNull();
  });

  it('limite un client read à ses pools, sans définition ni score', async () => {
    expect((await get('/pools', admin)).body.items.map((p) => p.slug)).toEqual(['lora', 'secret']);
    const list = await get('/pools', reader);
    expect(list.body.items).toEqual([expect.objectContaining({ slug: 'lora', label: 'LoRA', items: 3 })]);

    expect((await get('/pools/secret', reader)).status).toBe(404);
    expect((await get('/pools/secret/items', reader)).status).toBe(404);

    const pool = (await get('/pools/lora', reader)).body;
    expect(pool).toMatchObject({ slug: 'lora', items: 3 });
    expect(pool).not.toHaveProperty('definition');
    expect(pool.usage_commercial).toContainEqual({ usage: 'libre', urls: 1 });
    expect(pool.top_domains).toHaveLength(3);

    const items = (await get('/pools/lora/items?limit=2', reader)).body;
    expect(items).toMatchObject({ total: 3, limit: 2, offset: 0 });
    expect(items.items.map((i) => i.rank)).toEqual([1, 2]);
    expect(items.items[0]).not.toHaveProperty('score');
    expect(Object.keys(items.items[0]).sort()).toEqual([
      'description', 'domain', 'favicon', 'media_type', 'rank', 'source', 'thumbnail', 'title', 'url', 'usage_commercial',
    ]);
    // github.com : type déduit de l'URL (normalisé hors ligne), famille d'après le domaine
    expect(items.items[0]).toMatchObject({ domain: 'github.com', media_type: 'code', source: 'community', thumbnail: null, favicon: null });
  });

  it("donne à l'admin définition, scores et identifiants", async () => {
    const pool = (await get('/pools/lora', admin)).body;
    expect(pool.definition).toEqual({ theme: 'ia-generative', order: 'quality' });
    const items = (await get('/pools/lora/items', admin)).body.items;
    expect(typeof items[0].score).toBe('number');
    expect(typeof items[0].id).toBe('number');
  });

  it('réserve /admin aux clients admin', async () => {
    expect((await get('/admin/stats', reader)).status).toBe(403);
    expect((await get('/admin/stats')).status).toBe(401);
  });

  it('agrège les volumes du tableau de bord', async () => {
    const s = (await get('/admin/stats', admin)).body;
    expect(s.pools).toBe(2);
    expect(s.url_item).toContainEqual({ status: 'classified', n: 3 });
    expect(s.domain_profile).toMatchObject({ total: 3, to_qualify: 2, excluded: 0 });
    expect(s.search_query).toEqual([{ status: 'active', n: 1 }]);
  });

  it('filtre le corpus et rend la fiche complète d’une URL', async () => {
    const all = (await get('/admin/urls', admin)).body;
    expect(all.total).toBe(3);
    const byDomain = (await get('/admin/urls?domain=GitHub.com', admin)).body;
    expect(byDomain.items.map((u) => u.domain)).toEqual(['github.com']);
    // % est cherché littéralement
    expect((await get('/admin/urls?q=50%25', admin)).body.total).toBe(1);
    expect((await get('/admin/urls?q=%25', admin)).body.total).toBe(1);
    expect((await get('/admin/urls?theme=ia-generative', admin)).body.total).toBe(3);
    expect((await get('/admin/urls?status=bogus', admin)).status).toBe(400);
    expect((await get('/admin/urls?facet=usage-commercial:libre', admin)).body.total).toBe(1);

    const id = byDomain.items[0].id;
    const url = (await get(`/admin/urls/${id}`, admin)).body;
    expect(url).toMatchObject({ id, domain: 'github.com', usage_commercial: 'libre', status: 'classified' });
    expect(url.sources).toEqual([expect.objectContaining({ provider: 'file', query: 'forest lora', serp_rank: 1 })]);
    expect(url.themes.find((t) => t.is_primary)).toBeDefined();
    expect(url.pools.map((p) => p.slug)).toContain('lora');
    expect((await get('/admin/urls/999999', admin)).status).toBe(404);
    expect((await get('/admin/urls/abc', admin)).status).toBe(404);
  });

  it('rend la taxonomie en arbre et les facettes', async () => {
    const themes = (await get('/admin/themes', admin)).body.items;
    const ia = themes.find((t) => t.slug === 'ia-generative');
    expect(ia.primary_urls).toBe(3);
    expect(ia.children.map((c) => c.slug)).toContain('lora-training');
    const facets = (await get('/admin/facets', admin)).body.items;
    expect(facets.find((f) => f.slug === 'usage-commercial').values).toContainEqual({ value: 'libre', urls: 1 });
  });

  it('liste domaines, requêtes et runs', async () => {
    const toQualify = (await get('/admin/domains?to_qualify=true', admin)).body;
    expect(toQualify.total).toBe(2);
    expect(toQualify.items.every((d) => d.usage_commercial === null)).toBe(true);
    expect((await get('/admin/domains?usage=libre', admin)).body.items.map((d) => d.domain)).toEqual(['github.com']);

    const queries = (await get('/admin/queries', admin)).body;
    expect(queries.items).toEqual([expect.objectContaining({ query: 'lora dataset', priority: null, runs: 0 })]);

    const runs = (await get('/admin/runs?kind=pool', admin)).body;
    expect(runs.total).toBe(2);
    expect(runs.items[0].id).toBeGreaterThan(runs.items[1].id);
  });

  it('exporte un pool aux formats de la CLI', async () => {
    const csv = await get('/admin/pools/lora/export?format=csv', admin);
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(csv.headers.get('content-disposition')).toBe('attachment; filename="lora.csv"');
    expect(csv.body.split('\n')[0]).toBe('rank,url,domain,title,score');
    expect((await get('/admin/pools/nope/export', admin)).status).toBe(404);
    expect((await get('/admin/pools/lora/export?format=xml', admin)).status).toBe(400);
  });

  it('serve démarre, répond et s\u2019arrête sur SIGTERM', async () => {
    const { serve } = await import('../../src/api/index.js');
    const lines = [];
    let resolveStarted;
    const started = new Promise((r) => (resolveStarted = r));
    const done = serve({
      port: 0,
      host: '127.0.0.1',
      corsOrigins: [],
      log: (line) => {
        lines.push(line);
        if (line.startsWith('webpool API sur')) resolveStarted(line);
      },
    });
    const url = /http:\/\/[^ ]+/.exec(await started)[0];
    expect((await fetch(`${url}/health`)).status).toBe(200);
    process.emit('SIGTERM');
    await done;
    expect(lines.some((l) => l.startsWith('GET /api/v1/health 200'))).toBe(true);
  });
});
