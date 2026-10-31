import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSchema, dbAvailable, dbRequired, dropSchema, resetData, writeTempJson } from './helpers.js';

const available = await dbAvailable();
if (!available && dbRequired()) {
  throw new Error('[integration] PostgreSQL injoignable alors que la suite est requise (CI ou WEBPOOL_IT_REQUIRED).');
}

const PRICES = [
  { provider: 'brave', unit_price: 10, max_pages: 3 },
  { provider: 'openrouter', unit_price: 11, max_pages: 1 },
];

describe.skipIf(!available)('recherches payantes, dons et giri', () => {
  let db;
  let billing;
  let requests;
  let ingest;
  let clients;
  let who;
  let server;
  let base;

  beforeAll(async () => {
    await createSchema();
    db = await import('../../src/db.js');
    await resetData((...a) => db.query(...a));
    billing = await import('../../src/billing/index.js');
    requests = await import('../../src/requests/index.js');
    ({ ingest } = await import('../../src/ingest/index.js'));
    clients = await import('../../src/api/clients.js');
    const { normalizePending } = await import('../../src/normalize/index.js');
    const { classifyPending } = await import('../../src/classify/index.js');
    const pools = await import('../../src/pools/index.js');

    await ingest({
      provider: 'file',
      searchQuery: 'forest lora',
      input: writeTempJson('base.json', [{ url: 'https://github.com/kohya-ss/sd-scripts', title: 'kohya LoRA training scripts' }]),
    });
    await normalizePending({ offline: true });
    await classifyPending({});
    await pools.createPool({ slug: 'lora', definition: { theme: 'ia-generative', include_requests: true } });
    await pools.refreshPool('lora');
    await pools.createPool({ slug: 'autre', definition: { theme: 'ia-generative' } });

    who = {};
    for (const name of ['alice', 'bob', 'carol', 'dave']) who[name] = await clients.addClient({ name });
    who.admin = await clients.addClient({ name: 'moi', scope: 'admin' });
    await clients.setPoolAccess({ name: 'carol', slug: 'lora', granted: true });

    const { routes } = await import('../../src/api/index.js');
    const { createApiServer } = await import('../../src/api/server.js');
    server = createApiServer({ routes, authenticate: clients.authenticate });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
  });

  afterAll(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    await db?.closePool();
    await dropSchema();
  });

  const call = async (method, path, client, body) => {
    const headers = { ...(client ? { Authorization: `Bearer ${client.token}` } : {}) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  // Le solde tenu à jour est toujours la somme des écritures.
  async function expectLedgerConsistent() {
    const { rows } = await db.query(
      `SELECT w.id, w.balance, coalesce(sum(e.delta), 0) AS total
         FROM wallet w LEFT JOIN wallet_entry e ON e.wallet_id = w.id GROUP BY w.id`,
    );
    for (const r of rows) expect(Number(r.balance)).toBe(Number(r.total));
  }

  it('communautés : membres, rôles, pools rattachés, erreurs', async () => {
    await billing.addCommunity({ slug: 'atelier', label: 'Atelier' });
    await expect(billing.addCommunity({ slug: 'atelier' })).rejects.toThrow('Communauté existante');
    await expect(billing.addCommunity({ slug: 'Pas Bon' })).rejects.toThrow('Slug de communauté invalide');
    await billing.setMember({ community: 'atelier', name: 'alice', role: 'owner' });
    await billing.setMember({ community: 'atelier', name: 'bob', monthlyLimit: 15 });
    await billing.setCommunityPool({ community: 'atelier', pool: 'lora', attached: true });
    await expect(billing.setMember({ community: 'atelier', name: 'bob', role: 'roi' })).rejects.toThrow('role invalide');
    await expect(billing.setMember({ community: 'atelier', name: 'bob', monthlyLimit: -1 })).rejects.toThrow('plafond mensuel');
    // relancer sans --role ni --monthly ne change rien
    expect(await billing.setMember({ community: 'atelier', name: 'bob' })).toMatchObject({ role: 'member', monthlyLimit: 15 });
    await expect(billing.setMember({ community: 'nulle', name: 'bob' })).rejects.toThrow('Communauté inconnue');
    await expect(billing.setCommunityPool({ community: 'atelier', pool: 'nope', attached: true })).rejects.toThrow('Pool inconnu');
    await expect(billing.removeMember({ community: 'atelier', name: 'carol' })).rejects.toThrow("n'est pas membre");

    const [c] = await billing.listCommunities();
    expect(c).toEqual({ slug: 'atelier', label: 'Atelier', balance: 0, members: ['alice:owner', 'bob:member'], pools: ['lora'] });
  });

  it('les membres voient les pools de la communauté sans accord individuel', async () => {
    expect((await call('GET', '/pools', who.bob)).body.items.map((p) => p.slug)).toEqual(['lora']);
    expect((await call('GET', '/pools/lora', who.bob)).status).toBe(200);
    expect((await call('GET', '/pools/autre', who.bob)).status).toBe(404);
    expect((await call('GET', '/pools', who.dave)).body.items).toEqual([]);
  });

  it('crédit : don sur un client, achat sur une communauté, un paiement crédité une fois', async () => {
    // Sous 2 €, les frais fixes du paiement dépassent la marge : refus sans --force.
    await expect(billing.credit({ name: 'carol', cents: 100, reference: 'liberapay:1' })).rejects.toThrow('sous le minimum de 2.00 €');
    expect(await billing.credit({ name: 'carol', cents: 100, reference: 'liberapay:1', force: true })).toEqual({ giri: 1000, balance: 1000, kind: 'donation' });
    await expect(billing.credit({ name: 'carol', cents: 100, reference: 'liberapay:1', force: true })).rejects.toThrow('Paiement déjà crédité');
    await expect(billing.credit({ name: 'carol', cents: 100 })).rejects.toThrow('--ref requis');
    await expect(billing.credit({ name: 'carol', community: 'atelier', cents: 100, reference: 'x' })).rejects.toThrow('pas les deux');
    expect(await billing.credit({ community: 'atelier', cents: 5, reference: 'virement:7', force: true })).toMatchObject({ giri: 50, kind: 'purchase' });
    await expect(billing.adjust({ name: 'dave', giri: -1, note: 'test' })).rejects.toThrow('Solde insuffisant');
    await expect(billing.adjust({ name: 'dave', giri: 5 })).rejects.toThrow('--note requis');
    await expectLedgerConsistent();
  });

  it('achat : débit d\'avance, plafond du membre, pool de la communauté exigé', async () => {
    const bob = { clientId: who.bob.id, prices: PRICES };
    const first = await requests.createRequest({ ...bob, provider: 'brave', query: ' lora  forest ', community: 'atelier', pool: 'lora' });
    expect(first.balance).toBe(40);
    expect(first.request).toMatchObject({ status: 'queued', query: 'lora forest', price: 10, community: 'atelier', pool: 'lora', client: 'bob' });

    await expect(requests.createRequest({ ...bob, provider: 'brave', query: 'q', community: 'atelier', pool: 'lora' }))
      .rejects.toMatchObject({ code: 'spend_limit' });
    await expect(requests.createRequest({ ...bob, provider: 'brave', query: 'q', community: 'atelier' }))
      .rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('pool requis') });
    await expect(requests.createRequest({ ...bob, provider: 'brave', query: 'q', community: 'atelier', pool: 'autre' }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(requests.createRequest({ clientId: who.carol.id, prices: PRICES, provider: 'brave', query: 'q', community: 'atelier', pool: 'lora' }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(requests.createRequest({ ...bob, provider: 'file', query: '/etc/passwd' })).rejects.toMatchObject({ code: 'invalid' });

    // Sans giri : rien n'est écrit.
    await expect(requests.createRequest({ clientId: who.dave.id, prices: PRICES, provider: 'brave', query: 'q' }))
      .rejects.toMatchObject({ code: 'insufficient_balance' });
    const { rows } = await db.query('SELECT count(*)::int AS n FROM search_request WHERE api_client_id = $1', [who.dave.id]);
    expect(rows[0].n).toBe(0);
    await expectLedgerConsistent();
  });

  it('file d\'attente bornée, annulation remboursée par son auteur seulement', async () => {
    const carol = { clientId: who.carol.id, prices: PRICES, maxQueued: 2 };
    const a = await requests.createRequest({ ...carol, provider: 'openrouter', query: 'a' });
    await requests.createRequest({ ...carol, provider: 'brave', query: 'b' });
    await expect(requests.createRequest({ ...carol, provider: 'brave', query: 'c' })).rejects.toMatchObject({ code: 'too_many_queued' });

    await expect(requests.cancelRequest({ id: a.request.id, clientId: who.bob.id })).rejects.toMatchObject({ code: 'not_found' });
    const cancelled = await requests.cancelRequest({ id: a.request.id, clientId: who.carol.id });
    expect(cancelled).toMatchObject({ refunded: 11, request: { status: 'cancelled', refunded: 11 } });
    await expect(requests.cancelRequest({ id: a.request.id, clientId: who.carol.id })).rejects.toThrow('déjà cancelled');
    expect((await billing.walletOf({ name: 'carol' })).balance).toBe(990);
  });

  it('exécution : pages jusqu\'à la première vide, reste remboursé, URLs dans le pool visé', async () => {
    const pages = [
      writeTempJson('p0.json', [
        { url: 'https://unsplash.com/photos/forest-1', title: 'Forest photo' },
        { url: 'https://github.com/kohya-ss/sd-scripts', title: 'kohya LoRA training scripts' },
      ]),
      writeTempJson('p1.json', []),
    ];
    const seen = [];
    // Les appels au provider passent par le provider hors ligne, page par page.
    const fakeIngest = (args) => {
      seen.push(args);
      if (args.searchQuery === 'panne') throw new Error('HTTP 402 (crédit épuisé)');
      return ingest({ ...args, provider: 'file', input: pages[args.page] ?? pages[1] });
    };
    // La recherche `b` de carol, encore en attente, est annulée pour libérer sa file.
    const { rows: queued } = await db.query(`SELECT id FROM search_request WHERE status = 'queued' AND query = 'b'`);
    await requests.cancelRequest({ id: Number(queued[0].id), clientId: who.carol.id });
    const carol = await requests.createRequest({ clientId: who.carol.id, prices: PRICES, provider: 'brave', query: 'forest', pages: 3, pool: 'lora' });
    const failing = await requests.createRequest({ clientId: who.carol.id, prices: PRICES, provider: 'brave', query: 'panne' });

    const res = await requests.runRequests({ offline: true, ingestImpl: fakeIngest });
    const byId = Object.fromEntries(res.requests.map((r) => [r.id, r]));
    // La recherche de bob, encore en attente, passe d'abord (ordre d'achat) et trouve la photo la première.
    expect(res.requests.map((r) => r.id)).toEqual([1, carol.request.id, failing.request.id]);
    expect(byId[1]).toMatchObject({ calls: 1, newUrls: 1, refunded: 0 });
    expect(byId[carol.request.id]).toMatchObject({ calls: 2, newUrls: 0, refunded: 10, error: null });
    expect(byId[failing.request.id]).toMatchObject({ calls: 0, refunded: 10, error: 'HTTP 402 (crédit épuisé)' });
    expect(seen.find((s) => s.searchQuery === 'forest')).toMatchObject({ requestId: carol.request.id, page: 0 });
    expect(res.pools).toEqual([{ slug: 'lora', count: 2 }]);

    const { items } = await requests.listRequests({ clientId: who.carol.id });
    const done = items.find((r) => r.id === carol.request.id);
    expect(done).toMatchObject({ status: 'done', calls_done: 2, results: 2, new_urls: 0, refunded: 10, in_pool: 2 });
    expect(items.find((r) => r.id === failing.request.id)).toMatchObject({ status: 'failed', refunded: 10 });

    // La photo Unsplash n'est pas ia-generative : elle n'entre que par include_requests.
    const { rows } = await db.query(
      `SELECT ui.domain FROM pool_item pi JOIN pool p ON p.id = pi.pool_id JOIN url_item ui ON ui.id = pi.url_item_id
        WHERE p.slug = 'lora' ORDER BY ui.domain`,
    );
    expect(rows.map((r) => r.domain)).toEqual(['github.com', 'unsplash.com']);
    const { rows: costs } = await db.query('SELECT cost_usd::float8 AS c FROM search_request WHERE id = $1', [carol.request.id]);
    expect(costs[0].c).toBeCloseTo(0.01, 6); // deux appels Brave estimés à 0,005 $
    await expectLedgerConsistent();
  });

  it('clôt une recherche interrompue et rembourse les appels non faits', async () => {
    const r = await requests.createRequest({ clientId: who.carol.id, prices: PRICES, provider: 'brave', query: 'crash', pages: 2 });
    await db.query(`UPDATE search_request SET status = 'running', calls_done = 1, started_at = now() - interval '2 hours' WHERE id = $1`, [r.request.id]);
    const res = await requests.runRequests({ offline: true, ingestImpl: () => { throw new Error('pas appelé'); } });
    expect(res).toMatchObject({ recovered: 1, requests: [] });
    const { items } = await requests.listRequests({ clientId: who.carol.id, status: 'done' });
    expect(items.find((i) => i.id === r.request.id)).toMatchObject({ refunded: 10, error: 'exécution interrompue' });
    await expectLedgerConsistent();
  });

  it("include_requests : une recherche personnelle n'injecte rien dans le pool", async () => {
    const input = writeTempJson('perso.json', [{ url: 'https://flickr.com/photos/forest-2', title: 'Forest photo two' }]);
    const r = await requests.createRequest({ clientId: who.carol.id, prices: PRICES, provider: 'brave', query: 'perso', pool: 'lora' });
    await requests.runRequests({ offline: true, ingestImpl: (args) => ingest({ ...args, provider: 'file', input }) });
    const { items } = await requests.listRequests({ clientId: who.carol.id });
    expect(items.find((i) => i.id === r.request.id)).toMatchObject({ status: 'done', new_urls: 1, in_pool: 0 });
    const { rows } = await db.query(
      `SELECT 1 FROM pool_item pi JOIN pool p ON p.id = pi.pool_id JOIN url_item ui ON ui.id = pi.url_item_id
        WHERE p.slug = 'lora' AND ui.domain = 'flickr.com'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('rapport : crédits, giri dépensés nets, coût et marge par provider', async () => {
    const report = await billing.billingReport({ days: 30, usdEur: 1, giriPerEur: 1000 });
    expect(report.credits).toEqual([
      { kind: 'donation', entries: 1, giri: 1000, eur: 1 },
      { kind: 'purchase', entries: 1, giri: 50, eur: 0.05 },
    ]);
    const brave = report.providers.find((p) => p.provider === 'brave');
    // bob : 10 giri, forest : 20 gardés, crash : 10, perso : 10 ; panne remboursée ; annulées sans appel
    expect(brave).toMatchObject({ giri: 50, calls: 5 });
    expect(brave.margin_eur).toBeCloseTo(0.05 - brave.cost_usd, 6);
    // Encours : tout ce qui reste sur les portefeuilles, dû en recherches.
    const { rows } = await db.query(
      `SELECT sum(balance) FILTER (WHERE api_client_id IS NOT NULL)::int AS p, sum(balance) FILTER (WHERE community_id IS NOT NULL)::int AS c FROM wallet`,
    );
    expect(report.outstanding).toEqual({ personal: rows[0].p, communities: rows[0].c, eur: (rows[0].p + rows[0].c) / 1000 });
  });

  describe('API', () => {
    it('GET /billing : prix, solde personnel, communautés avec plafond et dépense', async () => {
      const { status, body } = await call('GET', '/billing', who.bob);
      expect(status).toBe(200);
      expect(body).toMatchObject({ giri_per_eur: 1000, funding_url: null, personal: { balance: 0 } });
      expect(body.prices.map((p) => p.provider)).toEqual(['openrouter', 'brave']);
      expect(body.prices[0]).not.toHaveProperty('cost_usd');
      expect(body.communities).toEqual([
        { slug: 'atelier', label: 'Atelier', role: 'member', balance: 40, monthly_limit: 15, spent_30d: 10, pools: ['lora'] },
      ]);
    });

    it('POST /requests : 201 payée, 402 sans giri, 400 champ inconnu, 415 hors JSON', async () => {
      await billing.credit({ name: 'dave', cents: 2, reference: 'ko-fi:9', force: true });
      const ok = await call('POST', '/requests', who.dave, { provider: 'brave', query: 'nagasaki' });
      expect(ok.status).toBe(201);
      expect(ok.body.request).toMatchObject({ status: 'queued', provider: 'brave', client: 'dave' });
      const price = ok.body.request.price;
      expect(ok.body.balance).toBe(20 - price);

      const broke = await call('POST', '/requests', who.dave, { provider: 'brave', query: 'x', pages: 3 });
      expect(broke).toMatchObject({ status: 402, body: { error: { code: 'insufficient_balance' } } });
      expect((await call('POST', '/requests', who.dave, { provider: 'brave', query: 'x', prix: 0 })).status).toBe(400);
      expect((await call('POST', '/requests', who.dave, { provider: 'file', query: '/etc/passwd' })).status).toBe(400);
      expect((await call('POST', '/requests', who.dave, [])).status).toBe(400);
      const form = await fetch(`${base}/requests`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${who.dave.token}`, 'Content-Type': 'text/plain' },
        body: '{}',
      });
      expect(form.status).toBe(415);

      const mine = await call('GET', '/requests', who.dave);
      expect(mine.body).toMatchObject({ total: 1, items: [{ query: 'nagasaki' }] });
      const del = await call('DELETE', `/requests/${ok.body.request.id}`, who.dave);
      expect(del.body).toMatchObject({ refunded: price, request: { status: 'cancelled' } });
      expect((await call('DELETE', `/requests/${ok.body.request.id}`, who.bob)).status).toBe(404);
    });

    it('grand livre et recherches de la communauté : propriétaires seulement', async () => {
      expect((await call('GET', '/requests?community=atelier', who.bob)).status).toBe(404);
      expect((await call('GET', '/billing/entries?community=atelier', who.bob)).status).toBe(404);
      const reqs = await call('GET', '/requests?community=atelier', who.alice);
      expect(reqs.body.items.map((r) => r.client)).toEqual(['bob']);
      const entries = await call('GET', '/billing/entries?community=atelier', who.alice);
      expect(entries.body.items.map((e) => [e.kind, e.delta, e.client])).toEqual([
        ['debit', -10, 'bob'],
        ['purchase', 50, null],
      ]);
      const mine = await call('GET', '/billing/entries', who.dave);
      expect(mine.body.items.map((e) => e.kind)).toEqual(['refund', 'debit', 'donation']);
      expect((await call('GET', '/billing/entries', who.bob)).body).toMatchObject({ items: [], total: 0 });
    });

    it('GET /admin/requests : toutes les recherches, admin seulement', async () => {
      expect((await call('GET', '/admin/requests', who.alice)).status).toBe(403);
      const all = await call('GET', '/admin/requests?status=failed', who.admin);
      expect(all.body.items.map((r) => r.query)).toEqual(['panne']);
      await expectLedgerConsistent();
    });

    it('pool public : visible, exportable et ciblable par tout client, sans accord', async () => {
      const pools = await import('../../src/pools/index.js');
      expect((await call('GET', '/pools/autre', who.dave)).status).toBe(404);
      await pools.setPoolPublic('autre', true);
      expect((await call('GET', '/pools', who.dave)).body.items.map((p) => [p.slug, p.public])).toEqual([['autre', true]]);
      expect((await call('GET', '/pools/autre', who.dave)).body).toMatchObject({ slug: 'autre', public: true });
      const res = await requests.createRequest({ clientId: who.dave.id, prices: PRICES, provider: 'brave', query: 'q', pool: 'autre' });
      expect(res.request.pool).toBe('autre');
      await requests.cancelRequest({ id: res.request.id, clientId: who.dave.id });
      await pools.setPoolPublic('autre', false);
      expect((await call('GET', '/pools/autre', who.dave)).status).toBe(404);
      await expect(pools.setPoolPublic('nope', true)).rejects.toThrow('Pool inconnu');
    });

    it('membres gérés par les propriétaires, qui gardent toujours un propriétaire', async () => {
      expect((await call('GET', '/communities/atelier/members', who.bob)).status).toBe(404);
      const list = await call('GET', '/communities/atelier/members', who.alice);
      expect(list.body.items.map((m) => [m.name, m.role, m.monthly_limit, m.spent_30d])).toEqual([
        ['alice', 'owner', null, 0],
        ['bob', 'member', 15, 10],
      ]);
      expect((await call('PUT', '/communities/atelier/members/dave', who.bob, {})).status).toBe(404);
      const added = await call('PUT', '/communities/atelier/members/dave', who.alice, { monthly_limit: 100 });
      expect(added.body).toEqual({ community: 'atelier', name: 'dave', role: 'member', monthly_limit: 100 });
      expect((await call('PUT', '/communities/atelier/members/personne', who.alice, {})).status).toBe(404);
      expect((await call('PUT', '/communities/atelier/members/dave', who.alice, { monthly_limit: -1 })).status).toBe(400);
      expect((await call('PUT', '/communities/atelier/members/dave', who.alice, { quota: 1 })).status).toBe(400);
      // dernier propriétaire : ni rétrogradé ni retiré
      const demote = await call('PUT', '/communities/atelier/members/alice', who.alice, { role: 'member' });
      expect(demote).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining('au moins un propriétaire') } } });
      expect((await call('DELETE', '/communities/atelier/members/alice', who.alice)).status).toBe(400);
      // upsert partiel : changer le rôle garde le plafond ; null le lève
      const promoted = await call('PUT', '/communities/atelier/members/dave', who.alice, { role: 'owner' });
      expect(promoted.body).toMatchObject({ role: 'owner', monthly_limit: 100 });
      expect((await call('PUT', '/communities/atelier/members/dave', who.alice, { monthly_limit: null })).body)
        .toMatchObject({ role: 'owner', monthly_limit: null });
      expect((await call('DELETE', '/communities/atelier/members/alice', who.alice)).status).toBe(200);
      expect((await call('GET', '/communities/atelier/members', who.alice)).status).toBe(404);
      expect((await call('DELETE', '/communities/atelier/members/alice', who.dave)).status).toBe(404);
    });
  });

  it('le grand livre survit : un client ou une communauté avec portefeuille ne se supprime pas', async () => {
    await expect(db.query(`DELETE FROM api_client WHERE name = 'carol'`)).rejects.toThrow(/violates foreign key/);
    await expect(db.query(`DELETE FROM community WHERE slug = 'atelier'`)).rejects.toThrow(/violates foreign key/);
  });

  it('verrou du pipeline : requests run passe son tour pendant un cycle', async () => {
    const { withPipelineLock } = await import('../../src/lock.js');
    let inner;
    await withPipelineLock(async () => {
      inner = await requests.runRequests({ offline: true });
    });
    expect(inner).toBeNull();
    expect(await requests.runRequests({ offline: true })).toMatchObject({ requests: [] });
  });
});
