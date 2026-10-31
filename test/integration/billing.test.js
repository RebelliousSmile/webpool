import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BASE_URL, SCHEMA, createSchema, dbAvailable, dbRequired, dropSchema, resetData, writeTempJson } from './helpers.js';

const run = promisify(execFile);
const available = await dbAvailable();
if (!available && dbRequired()) {
  throw new Error('[integration] PostgreSQL injoignable alors que la suite est requise (CI ou WEBPOOL_IT_REQUIRED).');
}

const PRICES = [
  { provider: 'brave', unit_price: 10, max_pages: 3 },
  { provider: 'openrouter', unit_price: 11, max_pages: 1 },
];

// Chaque test part du même état, posé par seed() : aucun test ne dépend d'un
// autre, et aucun identifiant n'est écrit en dur.
describe.skipIf(!available)('recherches payantes, dons et giri', () => {
  let db;
  let billing;
  let requests;
  let pools;
  let ingest;
  let clients;
  let server;
  let base;
  let who;

  beforeAll(async () => {
    await createSchema();
    db = await import('../../src/db.js');
    billing = await import('../../src/billing/index.js');
    requests = await import('../../src/requests/index.js');
    pools = await import('../../src/pools/index.js');
    ({ ingest } = await import('../../src/ingest/index.js'));
    clients = await import('../../src/api/clients.js');
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

  // Corpus d'une URL ia-generative ; pools `lora` (include_requests, communauté
  // atelier) et `autre` ; alice propriétaire, bob membre plafonné à 15 giri,
  // carol avec un accord direct sur lora et 1 000 giri, dave sans rien ; pot
  // d'atelier à 50 giri.
  beforeEach(async () => {
    await resetData((...a) => db.query(...a));
    const { normalizePending } = await import('../../src/normalize/index.js');
    const { classifyPending } = await import('../../src/classify/index.js');
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
    await billing.addCommunity({ slug: 'atelier', label: 'Atelier' });
    await billing.setMember({ community: 'atelier', name: 'alice', role: 'owner' });
    await billing.setMember({ community: 'atelier', name: 'bob', monthlyLimit: 15 });
    await billing.setCommunityPool({ community: 'atelier', pool: 'lora', attached: true });
    await billing.credit({ name: 'carol', cents: 100, reference: 'seed:carol', force: true });
    await billing.credit({ community: 'atelier', cents: 5, reference: 'seed:atelier', force: true });
  });

  const call = async (method, path, client, body, headers = {}) => {
    const h = { ...headers, ...(client ? { Authorization: `Bearer ${client.token}` } : {}) };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  const buy = (name, args) => requests.createRequest({ clientId: who[name].id, prices: PRICES, provider: 'brave', ...args });
  const balanceOf = async (owner) => (await billing.walletOf(owner)).balance;
  const poolDomains = async (slug) =>
    (
      await db.query(
        `SELECT ui.domain FROM pool_item pi JOIN pool p ON p.id = pi.pool_id JOIN url_item ui ON ui.id = pi.url_item_id
          WHERE p.slug = $1 ORDER BY ui.domain`,
        [slug],
      )
    ).rows.map((r) => r.domain);
  // Les appels au provider passent par le provider hors ligne, une page par fichier.
  const fakeIngest = (pageFiles, onCall = () => {}) => (args) => {
    onCall(args);
    return ingest({ ...args, provider: 'file', input: pageFiles[args.page] ?? writeTempJson('vide.json', []) });
  };

  // Le solde tenu à jour est toujours la somme des écritures.
  async function expectLedgerConsistent() {
    const { rows } = await db.query(
      `SELECT w.id, w.balance, coalesce(sum(e.delta), 0) AS total
         FROM wallet w LEFT JOIN wallet_entry e ON e.wallet_id = w.id GROUP BY w.id`,
    );
    for (const r of rows) expect(Number(r.balance)).toBe(Number(r.total));
  }

  describe('communautés et invitations', () => {
    it('admin : membres actifs d’office, rôles et pools ; erreurs', async () => {
      await expect(billing.addCommunity({ slug: 'atelier' })).rejects.toThrow('Communauté existante');
      await expect(billing.addCommunity({ slug: 'Pas Bon' })).rejects.toThrow('Slug de communauté invalide');
      await expect(billing.setMember({ community: 'atelier', name: 'bob', role: 'roi' })).rejects.toThrow('role invalide');
      await expect(billing.setMember({ community: 'atelier', name: 'bob', monthlyLimit: -1 })).rejects.toThrow('plafond mensuel');
      await expect(billing.setMember({ community: 'nulle', name: 'bob' })).rejects.toThrow('Communauté inconnue');
      await expect(billing.setCommunityPool({ community: 'atelier', pool: 'nope', attached: true })).rejects.toThrow('Pool inconnu');
      await expect(billing.removeMember({ community: 'atelier', name: 'carol' })).rejects.toThrow("n'est pas membre");
      // relancer sans rôle ni plafond ne change rien ; un nouveau membre reçoit le plafond par défaut
      expect(await billing.setMember({ community: 'atelier', name: 'bob' })).toMatchObject({ role: 'member', monthlyLimit: 15, accepted: true });
      expect(await billing.setMember({ community: 'atelier', name: 'dave' })).toMatchObject({ monthlyLimit: 1000, accepted: true });
      const [c] = await billing.listCommunities();
      expect(c).toEqual({ slug: 'atelier', label: 'Atelier', balance: 50, members: ['alice:owner', 'bob:member', 'dave:member'], pools: ['lora'] });
    });

    it("propriétaire : un client ajouté n'est qu'invité, sans pools ni pot, jusqu'à ce qu'il accepte", async () => {
      const invited = await call('PUT', '/communities/atelier/members/dave', who.alice, { monthly_limit: 100 });
      expect(invited.body).toEqual({ community: 'atelier', name: 'dave', role: 'member', monthly_limit: 100, accepted: false });
      expect((await call('GET', '/pools', who.dave)).body.items).toEqual([]);
      await expect(buy('dave', { query: 'q', pool: 'lora', community: 'atelier' })).rejects.toMatchObject({ code: 'not_found' });
      const members = (await call('GET', '/communities/atelier/members', who.alice)).body.items;
      expect(members.find((m) => m.name === 'dave')).toMatchObject({ accepted: false });

      const billingDave = (await call('GET', '/billing', who.dave)).body;
      expect(billingDave.communities).toEqual([]);
      expect(billingDave.invitations).toEqual([
        { slug: 'atelier', label: 'Atelier', role: 'member', monthly_limit: 100, invited_at: expect.any(String) },
      ]);
      expect((await call('POST', '/communities/atelier/invitation', who.dave)).body).toEqual({ community: 'atelier', accepted: true });
      expect((await call('POST', '/communities/atelier/invitation', who.dave)).status).toBe(404);
      expect((await call('GET', '/pools', who.dave)).body.items.map((p) => p.slug)).toEqual(['lora']);
      expect((await call('GET', '/billing', who.dave)).body.communities.map((c) => c.slug)).toEqual(['atelier']);
    });

    it('décliner une invitation la supprime ; quitter une communauté ; le dernier propriétaire reste', async () => {
      await call('PUT', '/communities/atelier/members/dave', who.alice, {});
      expect((await call('DELETE', '/communities/atelier/invitation', who.dave)).body).toEqual({ community: 'atelier', accepted: false });
      expect((await call('GET', '/billing', who.dave)).body.invitations).toEqual([]);

      expect((await call('DELETE', '/communities/atelier/membership', who.bob)).body).toEqual({ community: 'atelier', left: true });
      expect((await call('GET', '/pools', who.bob)).body.items).toEqual([]);
      const last = await call('DELETE', '/communities/atelier/membership', who.alice);
      expect(last).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining('au moins un propriétaire') } } });
      expect((await call('DELETE', '/communities/club/membership', who.alice)).status).toBe(404);
    });

    it('membres gérés par les propriétaires : upsert partiel, garde du dernier propriétaire', async () => {
      expect((await call('GET', '/communities/atelier/members', who.bob)).status).toBe(404);
      const list = await call('GET', '/communities/atelier/members', who.alice);
      expect(list.body.items.map((m) => [m.name, m.role, m.monthly_limit, m.spent_30d, m.contributed, m.accepted])).toEqual([
        ['alice', 'owner', null, 0, 0, true],
        ['bob', 'member', 15, 0, 0, true],
      ]);
      expect((await call('PUT', '/communities/atelier/members/dave', who.bob, {})).status).toBe(404);
      expect((await call('PUT', '/communities/atelier/members/personne', who.alice, {})).status).toBe(404);
      expect((await call('PUT', '/communities/atelier/members/bob', who.alice, { monthly_limit: -1 })).status).toBe(400);
      expect((await call('PUT', '/communities/atelier/members/bob', who.alice, { quota: 1 })).status).toBe(400);
      // changer le rôle garde le plafond ; null le lève
      expect((await call('PUT', '/communities/atelier/members/bob', who.alice, { role: 'owner' })).body)
        .toMatchObject({ role: 'owner', monthly_limit: 15, accepted: true });
      expect((await call('PUT', '/communities/atelier/members/bob', who.alice, { monthly_limit: null })).body)
        .toMatchObject({ monthly_limit: null });
      // alice peut partir maintenant que bob est propriétaire ; bob, seul, ne peut ni se rétrograder ni partir
      expect((await call('DELETE', '/communities/atelier/members/alice', who.bob)).status).toBe(200);
      expect((await call('PUT', '/communities/atelier/members/bob', who.bob, { role: 'member' })).status).toBe(400);
      expect((await call('DELETE', '/communities/atelier/members/bob', who.bob)).status).toBe(400);
      expect((await call('GET', '/communities/atelier/members', who.alice)).status).toBe(404);
    });
  });

  describe('accès aux pools', () => {
    it('les membres voient les pools de la communauté ; un pool public est visible par tous', async () => {
      expect((await call('GET', '/pools', who.bob)).body.items.map((p) => p.slug)).toEqual(['lora']);
      expect((await call('GET', '/pools/autre', who.bob)).status).toBe(404);
      expect((await call('GET', '/pools', who.dave)).body.items).toEqual([]);
      await pools.setPoolPublic('autre', true);
      expect((await call('GET', '/pools', who.dave)).body.items.map((p) => [p.slug, p.public])).toEqual([['autre', true]]);
      expect((await call('GET', '/pools/autre', who.dave)).body).toMatchObject({ slug: 'autre', public: true });
      await pools.setPoolPublic('autre', false);
      expect((await call('GET', '/pools/autre', who.dave)).status).toBe(404);
      await expect(pools.setPoolPublic('nope', true)).rejects.toThrow('Pool inconnu');
    });
  });

  describe('crédits', () => {
    it('don sur un client, apport au pot au nom d’un membre ; minimum, référence unique', async () => {
      await expect(billing.credit({ name: 'carol', cents: 100, reference: 'r1' })).rejects.toThrow('sous le minimum de 2.00 €');
      expect(await billing.credit({ name: 'dave', cents: 200, reference: 'r1' })).toEqual({ giri: 2000, balance: 2000, kind: 'donation' });
      await expect(billing.credit({ name: 'dave', cents: 200, reference: 'r1' })).rejects.toThrow('Paiement déjà crédité');
      await expect(billing.credit({ name: 'dave', cents: 200 })).rejects.toThrow('--ref requis');
      await expect(billing.credit({ name: 'dave', community: 'atelier', cents: 200, reference: 'x' })).rejects.toThrow('pas les deux');
      await expect(billing.credit({ community: 'atelier', contributor: 'carol', cents: 300, reference: 'x1' })).rejects.toThrow("carol n'est pas membre");
      await expect(billing.credit({ name: 'bob', contributor: 'bob', cents: 300, reference: 'x2' })).rejects.toThrow('--by');
      expect(await billing.credit({ community: 'atelier', contributor: 'alice', cents: 300, reference: 'r2' }))
        .toMatchObject({ giri: 3000, balance: 3050, kind: 'purchase' });
      expect(await balanceOf({ name: 'alice' })).toBe(0);
      const alice = (await call('GET', '/billing', who.alice)).body.communities[0];
      expect(alice).toMatchObject({ balance: 3050, contributed: 3000 });
      await expect(billing.adjust({ name: 'dave', giri: -5000, note: 'test' })).rejects.toThrow('Solde insuffisant');
      await expect(billing.adjust({ name: 'dave', giri: 5 })).rejects.toThrow('--note requis');
      await expectLedgerConsistent();
    });

    it('deux crédits simultanés de la même référence : un seul, l’autre en erreur métier', async () => {
      const results = await Promise.allSettled([
        billing.credit({ name: 'dave', cents: 200, reference: 'course' }),
        billing.credit({ name: 'dave', cents: 200, reference: 'course' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect(rejected.reason).toBeInstanceOf(billing.BillingError);
      expect(await balanceOf({ name: 'dave' })).toBe(2000);
    });
  });

  describe('achat', () => {
    it("débit d'avance ; pool de communauté payé par son pot, avec le plafond du membre", async () => {
      const personal = await buy('carol', { query: ' lora  forest ', pool: 'lora' });
      expect(personal).toMatchObject({ balance: 990, replayed: false, request: { query: 'lora forest', price: 10, community: null, pool: 'lora' } });
      const pot = await buy('bob', { query: 'q', pool: 'lora' });
      expect(pot).toMatchObject({ balance: 40, request: { community: 'atelier', client: 'bob' } });
      await expect(buy('bob', { query: 'q2', pool: 'lora' })).rejects.toMatchObject({ code: 'spend_limit' });
      await expect(buy('bob', { query: 'q', community: 'atelier' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('pool requis') });
      await expect(buy('bob', { query: 'q', community: 'atelier', pool: 'autre' })).rejects.toMatchObject({ code: 'not_found' });
      await expect(buy('carol', { query: 'q', community: 'atelier', pool: 'lora' })).rejects.toMatchObject({ code: 'not_found' });
      await expect(buy('bob', { provider: 'file', query: '/etc/passwd' })).rejects.toMatchObject({ code: 'invalid' });
      await expectLedgerConsistent();
    });

    it('pool de deux communautés du client : il faut dire laquelle paie', async () => {
      await billing.addCommunity({ slug: 'club' });
      await billing.setMember({ community: 'club', name: 'bob' });
      await billing.setCommunityPool({ community: 'club', pool: 'lora', attached: true });
      await expect(buy('bob', { query: 'q', pool: 'lora' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('atelier, club') });
      expect((await buy('bob', { query: 'q', pool: 'lora', community: 'atelier' })).request.community).toBe('atelier');
    });

    it("sans giri, rien n'est écrit ; deux achats simultanés pour un seul solde : un seul passe", async () => {
      await expect(buy('dave', { query: 'q' })).rejects.toMatchObject({ code: 'insufficient_balance' });
      const { rows } = await db.query('SELECT count(*)::int AS n FROM search_request WHERE api_client_id = $1', [who.dave.id]);
      expect(rows[0].n).toBe(0);
      await billing.credit({ name: 'dave', cents: 1, reference: 'dix', force: true });
      const results = await Promise.allSettled([buy('dave', { query: 'a' }), buy('dave', { query: 'b' })]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected').reason.code).toBe('insufficient_balance');
      expect(await balanceOf({ name: 'dave' })).toBe(0);
      await expectLedgerConsistent();
    });

    it("idempotence : la même clé rend la même recherche, un seul débit, même en concurrence", async () => {
      const [a, b] = await Promise.all([buy('carol', { query: 'q', idempotencyKey: 'k-1' }), buy('carol', { query: 'q', idempotencyKey: 'k-1' })]);
      expect(a.request.id).toBe(b.request.id);
      expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
      expect(await balanceOf({ name: 'carol' })).toBe(990);
      expect((await buy('carol', { query: 'q', idempotencyKey: 'k-2' })).request.id).not.toBe(a.request.id);
      await expect(buy('carol', { query: 'q', idempotencyKey: 'pas une clé !' })).rejects.toMatchObject({ code: 'invalid' });
    });

    it('file bornée ; annulation par son auteur ou un admin, message en français', async () => {
      const carol = { maxQueued: 2 };
      const a = await buy('carol', { ...carol, provider: 'openrouter', query: 'a' });
      const b = await buy('carol', { ...carol, query: 'b' });
      await expect(buy('carol', { ...carol, query: 'c' })).rejects.toMatchObject({ code: 'too_many_queued' });
      await expect(requests.cancelRequest({ id: a.request.id, clientId: who.bob.id })).rejects.toMatchObject({ code: 'not_found' });
      expect(await requests.cancelRequest({ id: a.request.id, clientId: who.carol.id })).toMatchObject({ refunded: 11, request: { status: 'cancelled' } });
      await expect(requests.cancelRequest({ id: a.request.id, clientId: who.carol.id })).rejects.toThrow(`Recherche ${a.request.id} déjà annulée`);
      // l'admin annule par l'API la recherche d'un autre
      expect((await call('DELETE', `/requests/${b.request.id}`, who.admin)).body).toMatchObject({ refunded: 10 });
      expect(await balanceOf({ name: 'carol' })).toBe(1000);
    });
  });

  describe('exécution', () => {
    it("pages jusqu'à la première vide, reste remboursé ; include_requests ne prend que les recherches de la communauté", async () => {
      const page0 = writeTempJson('p0.json', [{ url: 'https://unsplash.com/photos/forest-1', title: 'Forest photo' }]);
      const perso = writeTempJson('perso.json', [{ url: 'https://flickr.com/photos/forest-2', title: 'Forest photo two' }]);
      const pot = await buy('bob', { query: 'forest', pages: 1, pool: 'lora' });
      const personal = await buy('carol', { query: 'perso', pages: 3, pool: 'lora' });
      const seen = [];
      const files = { forest: [page0], perso: [perso] };
      const res = await requests.runRequests({
        offline: true,
        ingestImpl: (args) => fakeIngest(files[args.searchQuery], (a) => seen.push(a))(args),
      });
      expect(res.ok).toBe(true);
      expect(res.requests.map((r) => [r.id, r.calls, r.refunded])).toEqual([
        [pot.request.id, 1, 0],
        [personal.request.id, 2, 10], // page 1 vide : arrêt, page 2 remboursée
      ]);
      expect(seen.find((s) => s.searchQuery === 'forest')).toMatchObject({ requestId: pot.request.id, page: 0 });
      expect(res.processed).toEqual([pot.request.id, personal.request.id]);
      // La photo Unsplash, hors thème, entre par include_requests (pot d'atelier) ; celle de carol non (portefeuille personnel).
      expect(await poolDomains('lora')).toEqual(['github.com', 'unsplash.com']);
      const items = (await requests.listRequests({})).items;
      expect(items.find((i) => i.id === pot.request.id)).toMatchObject({ status: 'done', new_urls: 1, in_pool: 1 });
      expect(items.find((i) => i.id === personal.request.id)).toMatchObject({ status: 'done', refunded: 10, in_pool: 0 });
      const { rows } = await db.query('SELECT cost_usd::float8 AS c FROM search_request WHERE id = $1', [personal.request.id]);
      expect(rows[0].c).toBeCloseTo(0.01, 6); // deux appels Brave estimés à 0,005 $
      await expectLedgerConsistent();
    });

    it('include_requests : les URLs payées ne disputent pas `limit` à la sélection, elles s’y ajoutent', async () => {
      await db.query(`UPDATE pool SET definition = definition || '{"limit": 1, "order": "quality"}' WHERE slug = 'lora'`);
      const r = await buy('bob', { query: 'forest', pool: 'lora' });
      await requests.runRequests({ offline: true, ingestImpl: fakeIngest([writeTempJson('l.json', [{ url: 'https://unsplash.com/z', title: 'Forest' }])]) });
      const { rows } = await db.query(
        `SELECT ui.domain, pi.rank FROM pool_item pi JOIN pool p ON p.id = pi.pool_id JOIN url_item ui ON ui.id = pi.url_item_id
          WHERE p.slug = 'lora' ORDER BY pi.rank`,
      );
      expect(rows.map((x) => [x.domain, x.rank])).toEqual([['github.com', 1], ['unsplash.com', 2]]);
      expect((await requests.listRequests({})).items.find((i) => i.id === r.request.id).in_pool).toBe(1);
    });

    it("in_pool se calcule à la lecture : il suit un refresh fait par cycle ou pool refresh", async () => {
      const r = await buy('bob', { query: 'forest', pool: 'lora' });
      await requests.runRequests({ offline: true, ingestImpl: fakeIngest([writeTempJson('p.json', [{ url: 'https://unsplash.com/x', title: 'Forest' }])]) });
      const inPool = async () => (await requests.listRequests({})).items.find((i) => i.id === r.request.id).in_pool;
      expect(await inPool()).toBe(1);
      await db.query(`UPDATE pool SET definition = '{"theme": "ia-generative"}' WHERE slug = 'lora'`);
      await pools.refreshPool('lora');
      expect(await inPool()).toBe(0);
    });

    it('échec du provider : remboursé, message générique au client, brut à l’admin', async () => {
      const r = await buy('carol', { query: 'panne', pages: 2 });
      const res = await requests.runRequests({
        offline: true,
        ingestImpl: () => Promise.reject(Object.assign(new Error('BRAVE_API_KEY manquante'), { providerFailed: true })),
      });
      expect(res.requests).toEqual([expect.objectContaining({ id: r.request.id, calls: 0, refunded: 20 })]);
      const mine = await call('GET', '/requests', who.carol);
      expect(mine.body.items[0]).toMatchObject({ status: 'failed', error: requests.PUBLIC_ERRORS.provider });
      expect(mine.body.items[0].error).not.toContain('BRAVE');
      const adm = await call('GET', '/admin/requests?status=failed', who.admin);
      expect(adm.body.items[0].error).toBe('BRAVE_API_KEY manquante');
      expect(await balanceOf({ name: 'carol' })).toBe(1000);
    });

    it("échec d'écriture après un appel facturé : remboursé, mais son coût compte", async () => {
      const r = await buy('carol', { query: 'base' });
      await requests.runRequests({ offline: true, ingestImpl: () => Promise.reject(new Error('connexion perdue')) });
      const { rows } = await db.query('SELECT status, error_kind, refunded, cost_usd::float8 AS c FROM search_request WHERE id = $1', [r.request.id]);
      expect(rows[0]).toMatchObject({ status: 'failed', error_kind: 'internal', refunded: '10', c: 0.005 });
    });

    it('post-traitement en échec : la recherche est reprise au run suivant, même sans nouvelle recherche', async () => {
      const r = await buy('bob', { query: 'forest', pool: 'lora' });
      // facette inconnue : le refresh du pool échoue
      await db.query(`UPDATE pool SET definition = definition || '{"facets": {"inconnue": "x"}}' WHERE slug = 'lora'`);
      const first = await requests.runRequests({ offline: true, ingestImpl: fakeIngest([writeTempJson('p.json', [{ url: 'https://unsplash.com/y', title: 'Forest' }])]) });
      expect(first.ok).toBe(false);
      expect(first.steps.find((s) => s.name === 'pools').ok).toBe(false);
      const pending = await db.query('SELECT processed_at FROM search_request WHERE id = $1', [r.request.id]);
      expect(pending.rows[0].processed_at).toBeNull();

      await db.query(`UPDATE pool SET definition = definition - 'facets' WHERE slug = 'lora'`);
      const second = await requests.runRequests({ offline: true, ingestImpl: () => { throw new Error('pas appelé'); } });
      expect(second).toMatchObject({ ok: true, requests: [], processed: [r.request.id] });
      expect(await poolDomains('lora')).toContain('unsplash.com');
      const third = await requests.runRequests({ offline: true });
      expect(third.processed).toEqual([]);
    });

    it('recherche interrompue : close au run suivant, appels non faits remboursés', async () => {
      const r = await buy('carol', { query: 'crash', pages: 2 });
      await db.query(`UPDATE search_request SET status = 'running', calls_done = 1, started_at = now() WHERE id = $1`, [r.request.id]);
      const res = await requests.runRequests({ offline: true, ingestImpl: () => { throw new Error('pas appelé'); } });
      expect(res).toMatchObject({ recovered: 1, requests: [] });
      const item = (await requests.listRequests({ clientId: who.carol.id })).items[0];
      expect(item).toMatchObject({ status: 'done', refunded: 10, error: requests.PUBLIC_ERRORS.interrupted });
      await expectLedgerConsistent();
    });

    it('verrou du pipeline : requests run passe son tour pendant un cycle', async () => {
      const { withPipelineLock } = await import('../../src/lock.js');
      let inner;
      await withPipelineLock(async () => {
        inner = await requests.runRequests({ offline: true });
      });
      expect(inner).toBeNull();
      expect(await requests.runRequests({ offline: true })).toMatchObject({ requests: [], ok: true });
    });
  });

  describe('rapport et grand livre', () => {
    it('crédits, giri dépensés nets, coût, marge et encours', async () => {
      await buy('carol', { query: 'r', pages: 2 });
      await requests.runRequests({ offline: true, ingestImpl: fakeIngest([writeTempJson('r.json', [{ url: 'https://example.org/r', title: 'R' }])]) });
      const report = await billing.billingReport({ days: 30, usdEur: 1, giriPerEur: 1000 });
      expect(report.credits).toEqual([
        { kind: 'donation', entries: 1, giri: 1000, eur: 1 },
        { kind: 'purchase', entries: 1, giri: 50, eur: 0.05 },
      ]);
      expect(report.providers).toEqual([expect.objectContaining({ provider: 'brave', calls: 2, giri: 20 })]);
      expect(report.providers[0].margin_eur).toBeCloseTo(0.02 - 0.01, 6);
      expect(report.outstanding).toEqual({ personal: 980, communities: 50, eur: 1.03 });
    });

    it('le grand livre survit : un client ou une communauté avec portefeuille ne se supprime pas', async () => {
      await expect(db.query(`DELETE FROM api_client WHERE name = 'carol'`)).rejects.toThrow(/violates foreign key/);
      await expect(db.query(`DELETE FROM community WHERE slug = 'atelier'`)).rejects.toThrow(/violates foreign key/);
    });
  });

  describe('API', () => {
    it('GET /billing : prix, solde, communautés, invitations ; sans écrire', async () => {
      const { rows: before } = await db.query('SELECT count(*)::int AS n FROM wallet');
      const { status, body } = await call('GET', '/billing', who.bob);
      expect(status).toBe(200);
      expect(body).toMatchObject({ giri_per_eur: 1000, funding_url: null, personal: { balance: 0 }, invitations: [] });
      expect(body.prices.map((p) => p.provider)).toEqual(['openrouter', 'brave']);
      expect(body.prices[0]).not.toHaveProperty('cost_usd');
      expect(body.communities).toEqual([
        { slug: 'atelier', label: 'Atelier', role: 'member', balance: 50, monthly_limit: 15, spent_30d: 0, contributed: 0, pools: ['lora'] },
      ]);
      const { rows: after } = await db.query('SELECT count(*)::int AS n FROM wallet');
      expect(after[0].n).toBe(before[0].n);
    });

    it('POST /requests : 201, 200 sur clé rejouée, 402, 400, 415 ; DELETE', async () => {
      const ok = await call('POST', '/requests', who.carol, { provider: 'brave', query: 'nagasaki' }, { 'Idempotency-Key': 'abc' });
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ balance: 990, request: { status: 'queued', client: 'carol' } });
      expect(ok.body).not.toHaveProperty('replayed');
      const again = await call('POST', '/requests', who.carol, { provider: 'brave', query: 'nagasaki' }, { 'Idempotency-Key': 'abc' });
      expect(again.status).toBe(200);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(again.body.request.id).toBe(ok.body.request.id);

      expect((await call('POST', '/requests', who.dave, { provider: 'brave', query: 'x' })).body.error.code).toBe('insufficient_balance');
      expect((await call('POST', '/requests', who.carol, { provider: 'brave', query: 'x', prix: 0 })).status).toBe(400);
      expect((await call('POST', '/requests', who.carol, { provider: 'file', query: '/etc/passwd' })).status).toBe(400);
      expect((await call('POST', '/requests', who.carol, [])).status).toBe(400);
      const form = await fetch(`${base}/requests`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${who.carol.token}`, 'Content-Type': 'text/plain' },
        body: '{}',
      });
      expect(form.status).toBe(415);

      const del = await call('DELETE', `/requests/${ok.body.request.id}`, who.carol);
      expect(del.body).toMatchObject({ refunded: 10, request: { status: 'cancelled' } });
      expect((await call('DELETE', `/requests/${ok.body.request.id}`, who.bob)).status).toBe(404);
    });

    it('grand livre et recherches de la communauté : propriétaires seulement', async () => {
      await buy('bob', { query: 'q', pool: 'lora' });
      expect((await call('GET', '/requests?community=atelier', who.bob)).status).toBe(404);
      expect((await call('GET', '/billing/entries?community=atelier', who.bob)).status).toBe(404);
      expect((await call('GET', '/requests?community=atelier', who.alice)).body.items.map((r) => r.client)).toEqual(['bob']);
      const entries = await call('GET', '/billing/entries?community=atelier', who.alice);
      expect(entries.body.items.map((e) => [e.kind, e.delta, e.client])).toEqual([
        ['debit', -10, 'bob'],
        ['purchase', 50, null],
      ]);
      expect((await call('GET', '/billing/entries', who.dave)).body).toMatchObject({ items: [], total: 0 });
      expect((await call('GET', '/admin/requests', who.alice)).status).toBe(403);
    });
  });

  // Rôle PostgreSQL minimal documenté dans le README : l'achat doit passer.
  describe('rôle PostgreSQL minimal de l’API', () => {
    const role = `wp_api_${SCHEMA}`.slice(0, 60);
    afterAll(async () => {
      await db.query(`DROP OWNED BY ${role}`).catch(() => {});
      await db.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    });

    it('achat, annulation et gestion des membres avec les seuls GRANT du README', async () => {
      await db.query(`DROP ROLE IF EXISTS ${role}`);
      await db.query(`CREATE ROLE ${role} LOGIN PASSWORD 'api'`);
      for (const sql of [
        `GRANT USAGE ON SCHEMA ${SCHEMA} TO ${role}`,
        `GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${role}`,
        `GRANT INSERT, UPDATE ON search_request, wallet, wallet_entry TO ${role}`,
        `GRANT INSERT, UPDATE, DELETE ON community_member TO ${role}`,
        `GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${SCHEMA} TO ${role}`,
      ]) {
        await db.query(sql);
      }
      const url = new URL(BASE_URL);
      url.username = role;
      url.password = 'api';
      url.searchParams.set('options', `-c search_path=${SCHEMA}`);
      const root = new URL('../../', import.meta.url).pathname;
      const script = `
        import { createRequest, cancelRequest } from '${root}src/requests/index.js';
        import { ownerSetMember } from '${root}src/billing/index.js';
        import { closePool } from '${root}src/db.js';
        const a = JSON.parse(process.argv[1]);
        const res = await createRequest({ ...a.buy, prices: a.prices });
        await cancelRequest({ id: res.request.id, clientId: a.buy.clientId });
        const m = await ownerSetMember(a.member);
        console.log(JSON.stringify({ id: res.request.id, member: m }));
        await closePool();`;
      const args = {
        prices: PRICES,
        buy: { clientId: who.carol.id, provider: 'brave', query: 'role', idempotencyKey: 'r-1' },
        member: { clientId: who.alice.id, community: 'atelier', name: 'dave' },
      };
      const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(args)], {
        env: { ...process.env, DATABASE_URL: url.toString() },
      });
      expect(JSON.parse(stdout)).toMatchObject({ id: expect.any(Number), member: { name: 'dave', accepted: false } });
      expect(await balanceOf({ name: 'carol' })).toBe(1000);
    });
  });
});
