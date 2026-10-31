import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSchema, dbAvailable, dbRequired, dropSchema, resetData } from './helpers.js';

const available = await dbAvailable();
if (!available && dbRequired()) {
  throw new Error('[integration] PostgreSQL injoignable alors que la suite est requise (CI ou WEBPOOL_IT_REQUIRED).');
}

describe.skipIf(!available)('cycle sur PostgreSQL', () => {
  let db;
  let ex;
  let pools;
  let cy;
  const query = (...a) => db.query(...a);

  beforeAll(async () => {
    process.env.BRAVE_API_KEY = '';
    await createSchema();
    db = await import('../../src/db.js');
    ex = await import('../../src/explore/index.js');
    pools = await import('../../src/pools/index.js');
    cy = await import('../../src/cycle/index.js');
  });

  afterAll(async () => {
    await db?.closePool();
    await dropSchema();
  });

  beforeEach(async () => {
    await resetData(query);
  });

  // Export du provider file : une page de `n` URLs sur `n` domaines distincts.
  function exportOf(name, n) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpool-cy-'));
    const urls = Array.from({ length: n }, (_, i) => `https://${name}${i}.example.org/photo-${i}`);
    fs.writeFileSync(path.join(dir, `${name}-0.json`), JSON.stringify(urls));
    return path.join(dir, `${name}-{page}.json`);
  }
  const pending = async () =>
    (await query("SELECT count(*)::int AS n FROM url_item WHERE status IN ('pending', 'normalized')")).rows[0].n;

  it('150 URLs : tout est normalisé et classé, les 2 pools sont rafraîchis, une requête en échec ne bloque pas', async () => {
    for (const name of ['a', 'b', 'c']) await ex.addQuery({ provider: 'file', query: exportOf(name, 50) });
    const broken = await ex.addQuery({ provider: 'file', query: path.join(os.tmpdir(), 'webpool-absent-{page}.json') });
    await pools.createPool({ slug: 'tout', definition: { order: 'rarity', limit: 1000 } });
    await pools.createPool({ slug: 'a-seul', definition: { domains_include: ['a0.example.org', 'a1.example.org'] } });

    const res = await cy.cycle({ budget: 4, offline: true, exploreOptions: { limit: 50, sleep: async () => {} } });

    expect(res.ok).toBe(true);
    expect(res.steps.map((s) => [s.name, s.ok])).toEqual([
      ['explore', true],
      ['normalize', true],
      ['classify', true],
      ['media', true],
      ['pools', true],
    ]);
    expect(res.steps.find((st) => st.name === 'media').line).toBe('sautée (hors ligne)');
    const [exp, norm, cls, , pl] = res.steps;
    expect(exp.result.newUrls).toBe(150);
    expect(exp.result.errors).toBe(1);
    expect(exp.line).toContain(`#${broken.id} en échec`);
    expect(norm.result.normalized).toBe(150);
    expect(norm.result.batches).toBeGreaterThan(1);
    expect(cls.result.classified).toBe(150);
    expect(cls.line).toContain('150 domaines à qualifier');
    expect(await pending()).toBe(0);
    expect(pl.line).toBe('2/2 rafraîchis : a-seul 2, tout 150');

    const { rows } = await query(
      'SELECT error FROM search_query_run WHERE search_query_id = $1',
      [broken.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].error).toBeTruthy();
  });

  it('échoue quand chaque appel aux providers échoue, sans sauter les étapes suivantes', async () => {
    await ex.addQuery({ provider: 'file', query: path.join(os.tmpdir(), 'webpool-absent-{page}.json') });
    const res = await cy.cycle({ budget: 2, offline: true });
    expect(res.ok).toBe(false);
    expect(res.steps.map((s) => [s.name, s.ok])).toEqual([
      ['explore', false],
      ['normalize', true],
      ['classify', true],
      ['media', true],
      ['pools', true],
    ]);
    expect(res.steps.find((st) => st.name === 'pools').line).toBe('aucun pool');
  });

  it("exemple japon : les requêtes s'importent avec leurs tags, les pools se créent", async () => {
    const dir = path.join(import.meta.dirname, '..', '..', 'examples', 'japon');
    expect(await ex.importQueries(path.join(dir, 'queries.json'))).toEqual({ added: 24, updated: 0, skipped: 0 });
    const rows = await ex.listQueries({ status: 'active' });
    expect(rows).toHaveLength(24);
    for (const q of rows) {
      expect(q.tags).toEqual(['flot:japon', expect.stringMatching(/^lieu:(nagasaki|goto|kyoto|tokyo)$/), expect.stringMatching(/^lang:(ja|en|fr)$/)]);
    }
    expect(new Set(rows.map((q) => q.tags[2]))).toEqual(new Set(['lang:ja', 'lang:en', 'lang:fr']));

    const cls = await import('../../src/classify/index.js');
    await cls.classifyPending(); // synchronise les facettes lieu et usage-commercial
    const files = fs.readdirSync(path.join(dir, 'pools')).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      await pools.createPool({ slug: path.basename(f, '.json'), definitionFile: path.join(dir, 'pools', f) });
    }
    expect((await pools.listPools()).map((p) => p.slug)).toEqual(['goto', 'kyoto', 'nagasaki', 'nagasaki-libre', 'tokyo']);
  });

  it("une étape qui lève est notée en échec avec son message", async () => {
    const res = await cy.cycle({ budget: 0, offline: true });
    expect(res.ok).toBe(false);
    expect(res.steps[0]).toMatchObject({ name: 'explore', ok: false });
    expect(res.steps[0].line).toContain('--budget doit être un entier > 0');
  });
});
