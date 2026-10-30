import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSchema, dbAvailable, dbRequired, dropSchema, resetData, writeTempJson } from './helpers.js';

const available = await dbAvailable();
if (!available && dbRequired()) {
  throw new Error('[integration] PostgreSQL injoignable alors que la suite est requise (CI ou WEBPOOL_IT_REQUIRED).');
}

describe.skipIf(!available)('exploration sur PostgreSQL', () => {
  let db;
  let ex;
  const query = (...a) => db.query(...a);
  const noSleep = async () => {};

  beforeAll(async () => {
    // Jamais d'appel réseau : sans clé, Brave échoue avant toute requête
    // (process.loadEnvFile n'écrase pas une variable déjà définie).
    process.env.BRAVE_API_KEY = '';
    await createSchema();
    db = await import('../../src/db.js');
    ex = await import('../../src/explore/index.js');
  });

  afterAll(async () => {
    await db?.closePool();
    await dropSchema();
  });

  beforeEach(async () => {
    await resetData(query);
  });

  // Une requête du provider file : un export JSON par page, `{page}` dans le chemin.
  function pages(name, perPage) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpool-ex-'));
    perPage.forEach((urls, i) => fs.writeFileSync(path.join(dir, `${name}-${i}.json`), JSON.stringify(urls)));
    return path.join(dir, `${name}-{page}.json`);
  }
  const explore = (opts) => ex.explore({ sleep: noSleep, ...opts });
  const row = async (id) =>
    (await query('SELECT status, next_page, runs, dry_runs, exhausted_at FROM search_query WHERE id = $1', [id])).rows[0];

  it('query import : ajoute, ignore les requêtes connues, refuse un fichier invalide sans rien insérer', async () => {
    const file = writeTempJson('q.json', [
      { provider: 'file', query: 'a', tags: ['lieu:goto', 'lang:ja'] },
      { provider: 'file', query: 'b' },
      { provider: 'brave', query: 'a' },
    ]);
    expect(await ex.importQueries(file)).toEqual({ added: 3, skipped: 0 });
    expect(await ex.importQueries(file)).toEqual({ added: 0, skipped: 3 });

    const rows = await ex.listQueries({ status: 'active' });
    expect(rows.map((q) => [q.provider, q.query, q.tags, q.priority])).toEqual([
      ['file', 'a', ['lieu:goto', 'lang:ja'], Infinity],
      ['file', 'b', [], Infinity],
      ['brave', 'a', [], Infinity],
    ]);

    const bad = writeTempJson('bad.json', [{ provider: 'file', query: 'c' }, { provider: 'altavista', query: 'd' }]);
    await expect(ex.importQueries(bad)).rejects.toThrow(/Provider inconnu : altavista/);
    expect((await ex.listQueries()).length).toBe(3);
  });

  it('query add : refuse un doublon et un provider inconnu', async () => {
    await ex.addQuery({ provider: 'brave', query: 'kyoto', tags: ['lieu:kyoto'] });
    await expect(ex.addQuery({ provider: 'brave', query: 'kyoto' })).rejects.toThrow(/Requête existante pour brave/);
    await expect(ex.addQuery({ provider: 'altavista', query: 'kyoto' })).rejects.toThrow(/Provider inconnu/);
    await expect(ex.listQueries({ status: 'frobnicate' })).rejects.toThrow(/--status invalide/);
  });

  it('explore : budget respecté, rendement enregistré, page avancée, la requête neuve passe en premier', async () => {
    const a = await ex.addQuery({ provider: 'file', query: pages('a', [['https://a.com/1', 'https://a2.com/1'], ['https://a.com/2']]) });
    const b = await ex.addQuery({ provider: 'file', query: pages('b', [['https://b.com/1', 'https://b.com/2'], ['https://b.com/3']]) });
    const c = await ex.addQuery({ provider: 'file', query: pages('c', [['https://c.com/1'], ['https://c.com/2']]) });

    const first = await explore({ budget: 2 });
    expect(first).toMatchObject({ calls: 2, errors: 0, newUrls: 4, newDomains: 3 });
    // b.com deux fois dans la même page : un seul domaine nouveau.
    expect(first.queries.map((q) => [q.id, q.page, q.results, q.newUrls, q.newDomains])).toEqual([
      [a.id, 0, 2, 2, 2],
      [b.id, 0, 2, 2, 1],
    ]);
    expect((await query("SELECT count(*)::int AS n FROM processing_run WHERE kind = 'ingest'")).rows[0].n).toBe(2);
    expect(await row(a.id)).toMatchObject({ status: 'active', next_page: 1, runs: 1, dry_runs: 0 });

    // c n'a jamais tourné : elle passe avant a et b.
    const second = await explore({ budget: 1 });
    expect(second.queries.map((q) => q.id)).toEqual([c.id]);

    // a (2 domaines en 1 passage) devance b et c (1 domaine chacun).
    const third = await explore({ budget: 1 });
    expect(third.queries.map((q) => [q.id, q.page])).toEqual([[a.id, 1]]);

    const run = (await query("SELECT detail FROM processing_run WHERE kind = 'explore' ORDER BY id LIMIT 1")).rows[0];
    expect(run.detail).toMatchObject({ budget: 2, calls: 2, newDomains: 3 });
  });

  it('épuisement après deux passages à sec, puis retour après le repos depuis la page 0', async () => {
    const same = ['https://s.com/1'];
    const q = await ex.addQuery({ provider: 'file', query: pages('s', [same, same, same, same]) });

    await explore({ budget: 1, dryRunsLimit: 2 });
    await explore({ budget: 1, dryRunsLimit: 2 });
    expect(await row(q.id)).toMatchObject({ status: 'active', next_page: 2, dry_runs: 1 });
    const last = await explore({ budget: 1, dryRunsLimit: 2 });
    expect(last.queries[0]).toMatchObject({ page: 2, newUrls: 0, exhausted: true });
    expect(await row(q.id)).toMatchObject({ status: 'exhausted', dry_runs: 2 });

    // Pas encore reposée : plus choisie.
    expect(await explore({ budget: 5, restDays: 30 })).toMatchObject({ calls: 0, woken: 0 });

    await query("UPDATE search_query SET exhausted_at = now() - interval '31 days' WHERE id = $1", [q.id]);
    const back = await explore({ budget: 5, restDays: 30 });
    expect(back).toMatchObject({ woken: 1, calls: 1 });
    expect(back.queries[0].page).toBe(0);
    expect(await row(q.id)).toMatchObject({ status: 'active', next_page: 1, exhausted_at: null });
  });

  it('une erreur de provider est notée, la page n’avance pas et le run continue', async () => {
    const broken = await ex.addQuery({ provider: 'file', query: path.join(os.tmpdir(), 'webpool-absent-{page}.json') });
    const ok = await ex.addQuery({ provider: 'file', query: pages('ok', [['https://ok.com/1']]) });

    const res = await explore({ budget: 2 });
    expect(res).toMatchObject({ calls: 2, errors: 1, newUrls: 1 });
    expect(res.queries.find((q) => q.id === broken.id).error).toMatch(/ENOENT/);
    expect(await row(broken.id)).toMatchObject({ status: 'active', next_page: 0, runs: 0 });
    expect(await row(ok.id)).toMatchObject({ next_page: 1, runs: 1 });
    const runs = (await query('SELECT error FROM search_query_run WHERE search_query_id = $1', [broken.id])).rows;
    expect(runs).toHaveLength(1);
    expect(runs[0].error).toMatch(/ENOENT/);
  });

  it('--provider restreint la sélection ; pause entre deux appels Brave seulement', async () => {
    await ex.addQuery({ provider: 'brave', query: 'x' });
    await ex.addQuery({ provider: 'brave', query: 'y' });
    await ex.addQuery({ provider: 'file', query: pages('f', [['https://f.com/1']]) });

    const fileOnly = await explore({ budget: 5, provider: 'file' });
    expect(fileOnly.queries.map((q) => q.provider)).toEqual(['file']);

    const sleeps = [];
    const brave = await ex.explore({ budget: 5, provider: 'brave', sleep: async (ms) => sleeps.push(ms) });
    expect(brave).toMatchObject({ calls: 2, errors: 2 });
    expect(brave.queries[0].error).toMatch(/BRAVE_API_KEY manquante/);
    expect(sleeps).toEqual([1000]);
  });

  describe('exclusion des domaines saturés', () => {
    // `n` URLs normalisées par domaine, inscrites au registre.
    async function corpus(counts) {
      for (const [domain, n] of Object.entries(counts)) {
        await query('INSERT INTO domain_profile (domain) VALUES ($1) ON CONFLICT DO NOTHING', [domain]);
        await query(
          `INSERT INTO url_item (raw_url, canonical_url, domain, status)
           SELECT u, u, $1, 'normalized' FROM (SELECT 'https://' || $1 || '/' || i AS u FROM generate_series(1, $2) AS i) t`,
          [domain, n],
        );
      }
    }
    // Brave échoue sans clé, après que l'ingestion a tracé la requête envoyée.
    const lastSent = async () =>
      (await query("SELECT detail FROM processing_run WHERE kind = 'ingest' ORDER BY id DESC LIMIT 1")).rows[0].detail;
    const exploreBrave = (opts) => explore({ budget: 5, provider: 'brave', saturation: 2, ...opts });

    it('requête Brave : saturés les plus gros d’abord et exclus à la main ; file inchangé', async () => {
      await corpus({ 'a.com': 3, 'b.com': 5, 'c.com': 4, 'rare.com': 1 });
      const domains = await import('../../src/domains/index.js');
      await domains.setExploreExcluded({ domain: 'www.Pinterest.com', excluded: true });
      const q = await ex.addQuery({ provider: 'brave', query: 'temple' });
      await ex.addQuery({ provider: 'file', query: pages('f', [['https://f.com/1']]) });

      const res = await exploreBrave();
      expect(res.queries[0]).toMatchObject({ id: q.id, excluded: 4 });
      expect(await lastSent()).toMatchObject({
        query: 'temple',
        sentQuery: 'temple -site:b.com -site:c.com -site:a.com -site:pinterest.com',
      });

      await explore({ budget: 5, provider: 'file', saturation: 2 });
      expect(await lastSent()).not.toHaveProperty('sentQuery');
    });

    it('ensemble inchangé : pagination poursuivie ; ensemble changé : reprise page 0', async () => {
      await corpus({ 'a.com': 3 });
      const q = await ex.addQuery({ provider: 'brave', query: 'temple' });
      await exploreBrave();
      await query('UPDATE search_query SET next_page = 3, dry_runs = 1 WHERE id = $1', [q.id]);

      expect((await exploreBrave()).queries[0].page).toBe(3);
      expect(await row(q.id)).toMatchObject({ next_page: 3, dry_runs: 1 });

      await corpus({ 'b.com': 3 });
      expect((await exploreBrave()).queries[0].page).toBe(0);
      expect(await row(q.id)).toMatchObject({ next_page: 0, dry_runs: 0 });
    });

    it('longueur bornée et requête ciblée par site: jamais auto-exclue', async () => {
      await corpus({ 'unsplash.com': 9, 'pexels.com': 8, 'pixabay.com': 7 });
      await ex.addQuery({ provider: 'brave', query: 'photo site:unsplash.com' });
      await exploreBrave({ maxChars: 60 });
      const { sentQuery } = await lastSent();
      expect(sentQuery).toBe('photo site:unsplash.com -site:pexels.com -site:pixabay.com');
      expect(sentQuery.length).toBeLessThanOrEqual(60);
    });

    it('domain include : réintégré sauf s’il est saturé ; domaine inconnu refusé', async () => {
      await corpus({ 'small.com': 1, 'big.com': 3 });
      const domains = await import('../../src/domains/index.js');
      await domains.setExploreExcluded({ domain: 'small.com', excluded: true });
      await domains.setExploreExcluded({ domain: 'big.com', excluded: true });
      await domains.setExploreExcluded({ domain: 'small.com', excluded: false });
      await domains.setExploreExcluded({ domain: 'big.com', excluded: false });
      await expect(domains.setExploreExcluded({ domain: 'jamais.vu', excluded: false })).rejects.toThrow(
        /Domaine inconnu du registre : jamais\.vu/,
      );

      await ex.addQuery({ provider: 'brave', query: 'temple' });
      await exploreBrave();
      expect((await lastSent()).sentQuery).toBe('temple -site:big.com');
    });
  });
});
