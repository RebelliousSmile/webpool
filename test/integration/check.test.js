import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSchema, dbAvailable, dbRequired, dropSchema, resetData } from './helpers.js';

const available = await dbAvailable();
if (!available && dbRequired()) {
  throw new Error('[integration] PostgreSQL injoignable alors que la suite est requise (CI ou WEBPOOL_IT_REQUIRED).');
}

describe.skipIf(!available)('contrôle des liens sur PostgreSQL', () => {
  let db;
  let ck;
  let pools;
  let cy;
  const query = (...a) => db.query(...a);

  // Faux réseau : statut par URL, 200 par défaut ; une erreur levée simule un échec de connexion.
  let net;
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const r = net[url] ?? 200;
    if (r instanceof Error) throw r;
    return new Response('corps ignoré', { status: r, headers: { 'content-type': 'text/html' } });
  };
  const day = (n) => new Date(Date.UTC(2026, 10, 3 + n, 4, 0, 0));
  const check = (n, opts = {}) => ck.checkLinks({ fetchImpl, now: () => day(n), ...opts });
  const item = async (id) =>
    (await query('SELECT status, checked_at, dead_streak, quarantined_at, http_status FROM url_item WHERE id = $1', [id])).rows[0];

  async function addLink(url, status = 'classified') {
    const { rows } = await query(
      `INSERT INTO url_item (raw_url, canonical_url, domain, status, http_status, quality_score, relevance_score)
       VALUES ($1, $1, $2, $3, 200, 0.8, 0.8) RETURNING id`,
      [url, new URL(url).hostname, status],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    await createSchema();
    db = await import('../../src/db.js');
    ck = await import('../../src/check/index.js');
    pools = await import('../../src/pools/index.js');
    cy = await import('../../src/cycle/index.js');
  });

  afterAll(async () => {
    await db?.closePool();
    await dropSchema();
  });

  beforeEach(async () => {
    await resetData(query);
    net = {};
    calls.length = 0;
  });

  it('un 200 donne ok, historisé, sans réécrire http_status', async () => {
    const id = await addLink('https://sain.example/a');
    const res = await check(0);
    expect(res).toMatchObject({ checked: 1, ok: 1, dead: 0, unsure: 0, quarantined: 0, released: 0, purged: 0 });
    const { rows } = await query('SELECT http_status, verdict, error, final_url, run_id FROM url_check WHERE url_item_id = $1', [id]);
    expect(rows).toEqual([
      { http_status: 200, verdict: 'ok', error: null, final_url: 'https://sain.example/a', run_id: expect.anything() },
    ]);
    expect(await item(id)).toMatchObject({ checked_at: day(0), dead_streak: 0, quarantined_at: null, http_status: 200 });
    const run = (await query("SELECT kind, status FROM processing_run WHERE kind = 'check'")).rows;
    expect(run).toHaveLength(1);
  });

  it('trois 404 un jour sur deux mettent en quarantaine et sortent le lien du pool ; un 200 le rend', async () => {
    const dead = await addLink('https://mort.example/a');
    const ok = await addLink('https://sain.example/a');
    net['https://mort.example/a'] = 404;
    await pools.createPool({ slug: 'tout', definition: {} });

    for (const n of [0, 1]) {
      expect(await check(n)).toMatchObject({ dead: 1, quarantined: 0 });
    }
    expect(await check(2)).toMatchObject({ checked: 2, ok: 1, dead: 1, quarantined: 1 });
    expect(await item(dead)).toMatchObject({ status: 'classified', dead_streak: 3, quarantined_at: day(2) });

    const ids = async () =>
      (await query('SELECT url_item_id::int AS id FROM pool_item ORDER BY url_item_id')).rows.map((r) => r.id);
    await pools.refreshPool('tout');
    expect(await ids()).toEqual([Number(ok)]);

    net['https://mort.example/a'] = 200;
    expect(await check(3)).toMatchObject({ ok: 2, released: 1 });
    expect(await item(dead)).toMatchObject({ dead_streak: 0, quarantined_at: null });
    await pools.refreshPool('tout');
    expect(await ids()).toEqual([Number(dead), Number(ok)]);
  });

  it('les faux échecs (403, délai dépassé) sont incertains et ne touchent pas au compteur', async () => {
    const id = await addLink('https://bloque.example/a');
    net['https://bloque.example/a'] = 404;
    await check(0);
    net['https://bloque.example/a'] = 403;
    expect(await check(1)).toMatchObject({ unsure: 1 });
    net['https://bloque.example/a'] = new DOMException('timeout', 'TimeoutError');
    expect(await check(2)).toMatchObject({ unsure: 1 });
    expect(await item(id)).toMatchObject({ dead_streak: 1, quarantined_at: null });
    const { rows } = await query('SELECT verdict, http_status, error FROM url_check ORDER BY checked_at');
    expect(rows).toEqual([
      { verdict: 'dead', http_status: 404, error: null },
      { verdict: 'unsure', http_status: 403, error: null },
      { verdict: 'unsure', http_status: null, error: 'TimeoutError' },
    ]);
  });

  it('une connexion refusée est morte et étiquetée', async () => {
    const id = await addLink('https://refuse.example/a');
    net['https://refuse.example/a'] = new TypeError('fetch failed', {
      cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
    });
    expect(await check(0)).toMatchObject({ dead: 1 });
    expect((await query('SELECT error FROM url_check WHERE url_item_id = $1', [id])).rows[0].error).toBe('ECONNREFUSED');
  });

  it("un lien testé depuis moins de 20 h n'est pas resélectionné", async () => {
    await addLink('https://sain.example/a');
    await check(0);
    const after = (h) => new Date(day(0).getTime() + h * 3600_000);
    expect(await ck.checkLinks({ fetchImpl, now: () => after(19) })).toMatchObject({ checked: 0 });
    expect((await query('SELECT count(*)::int AS n FROM url_check')).rows[0].n).toBe(1);
    expect(await ck.checkLinks({ fetchImpl, now: () => after(20) })).toMatchObject({ checked: 1 });
  });

  it('limit borne la passe : jamais testés puis plus anciens ; pending et doublons ignorés', async () => {
    const a = await addLink('https://a.example/');
    const b = await addLink('https://b.example/');
    const c = await addLink('https://c.example/', 'normalized');
    await addLink('https://p.example/', 'pending');
    await addLink('https://d.example/', 'duplicate');
    expect(await check(0, { limit: 2 })).toMatchObject({ checked: 2 });
    expect(calls).toEqual(['https://a.example/', 'https://b.example/']);
    calls.length = 0;
    expect(await check(1, { limit: 2 })).toMatchObject({ checked: 2 });
    expect(calls).toEqual(['https://c.example/', 'https://a.example/']);
    expect((await item(a)).checked_at).toEqual(day(1));
    expect((await item(b)).checked_at).toEqual(day(0));
    expect((await item(c)).checked_at).toEqual(day(1));
  });

  it('purge les tests de plus de 90 jours', async () => {
    const id = await addLink('https://sain.example/a');
    await check(0);
    await check(30);
    expect(await check(91)).toMatchObject({ purged: 1 });
    const { rows } = await query('SELECT checked_at FROM url_check WHERE url_item_id = $1 ORDER BY checked_at', [id]);
    expect(rows.map((r) => r.checked_at)).toEqual([day(30), day(91)]);
  });

  it('cycle --offline saute le contrôle', async () => {
    await addLink('https://sain.example/a');
    const res = await cy.cycle({ budget: 1, offline: true });
    expect(res.steps.find((s) => s.name === 'check').line).toBe('sautée (hors ligne)');
    expect(calls).toEqual([]);
  });
});
