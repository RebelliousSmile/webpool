import fs from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSchema, dbAvailable, dropSchema, resetData, writeTempJson } from './helpers.js';

const available = await dbAvailable();
if (!available) {
  console.warn('[integration] PostgreSQL injoignable : suite ignorée (pnpm db:up pour la lancer).');
}

describe.skipIf(!available)('pipeline sur PostgreSQL', () => {
  let db;
  let ingest;
  let normalizePending;
  let classifyPending;
  let pools;
  let config;
  const { query } = { query: (...a) => db.query(...a) };

  beforeAll(async () => {
    await createSchema();
    db = await import('../../src/db.js');
    ({ ingest } = await import('../../src/ingest/index.js'));
    ({ normalizePending } = await import('../../src/normalize/index.js'));
    ({ classifyPending } = await import('../../src/classify/index.js'));
    pools = await import('../../src/pools/index.js');
    ({ config } = await import('../../src/config.js'));
  });

  afterAll(async () => {
    await db?.closePool();
    await dropSchema();
  });

  beforeEach(async () => {
    await resetData(query);
  });

  const serp = (urls) => writeTempJson('serp.json', urls.map((url) => ({ url, title: `T ${url}` })));
  const ingestUrls = (urls, searchQuery = 'q') =>
    ingest({ provider: 'file', searchQuery, input: serp(urls) });
  const count = async (table, where = 'TRUE') =>
    (await query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n;

  describe('ingest', () => {
    it('est idempotent sur les URLs, mais trace chaque découverte', async () => {
      const urls = ['https://a.com/x', 'https://b.com/y'];
      const first = await ingestUrls(urls, 'requête 1');
      expect(first).toMatchObject({ inserted: 2, existing: 0, total: 2 });

      const second = await ingestUrls(['https://a.com/x', 'https://c.com/z'], 'requête 2');
      expect(second).toMatchObject({ inserted: 1, existing: 1, total: 2 });

      expect(await count('url_item')).toBe(3);
      expect(await count('url_source')).toBe(4);
      const { rows } = await query(
        `SELECT us.query FROM url_source us JOIN url_item ui ON ui.id = us.url_item_id
          WHERE ui.raw_url = 'https://a.com/x' ORDER BY us.id`,
      );
      expect(rows.map((r) => r.query)).toEqual(['requête 1', 'requête 2']);
    });

    it('conserve rang, provider et run dans url_source', async () => {
      const { runId } = await ingestUrls(['https://a.com/x', 'https://b.com/y']);
      const { rows } = await query('SELECT provider, serp_rank, run_id FROM url_source ORDER BY serp_rank');
      expect(rows).toEqual([
        { provider: 'file', serp_rank: 1, run_id: runId },
        { provider: 'file', serp_rank: 2, run_id: runId },
      ]);
    });

    it("rejette un provider inconnu et une requête manquante sans créer de run", async () => {
      await expect(ingest({ provider: 'nope', searchQuery: 'q' })).rejects.toThrow(/Provider inconnu/);
      await expect(ingest({ provider: 'file' })).rejects.toThrow(/--query/);
      expect(await count('processing_run')).toBe(0);
    });
  });

  describe('normalize', () => {
    it('déduplique domaine+canonique et rattache les sources à la survivante', async () => {
      await ingestUrls(
        [
          'https://www.unsplash.com/s/photos/forest?utm_source=x',
          'https://unsplash.com/s/photos/forest',
          'https://example.com/autre',
        ],
        'forest',
      );
      const res = await normalizePending({ offline: true });
      expect(res).toMatchObject({ normalized: 2, duplicate: 1, error: 0, total: 3 });

      const { rows: dup } = await query(`SELECT id, duplicate_of FROM url_item WHERE status = 'duplicate'`);
      expect(dup).toHaveLength(1);
      const survivorId = dup[0].duplicate_of;
      expect(await count('url_source', `url_item_id = ${dup[0].id}`)).toBe(0);
      expect(await count('url_source', `url_item_id = ${survivorId}`)).toBe(2);
    });

    it('en ligne : suit le résultat du fetcher, marque les échecs en error sans casser le run', async () => {
      await ingestUrls(['https://a.com/ok', 'https://a.com/gone', 'https://a.com/down']);
      const fetcher = async (url) => {
        if (url.endsWith('/ok')) {
          return {
            finalUrl: 'https://a.com/redirige?utm_source=z',
            httpStatus: 200,
            html: '<head><title>Titre réel</title><link rel="canonical" href="/canon"></head>',
          };
        }
        if (url.endsWith('/gone')) return { finalUrl: url, httpStatus: 404, html: '' };
        throw new Error('timeout');
      };
      const res = await normalizePending({ fetcher });
      expect(res).toMatchObject({ normalized: 1, error: 2, duplicate: 0 });

      const { rows } = await query(
        'SELECT raw_url, status, canonical_url, title, http_status, error FROM url_item ORDER BY id',
      );
      expect(rows[0]).toMatchObject({
        status: 'normalized',
        canonical_url: 'https://a.com/canon',
        title: 'Titre réel',
        http_status: 200,
      });
      expect(rows[1]).toMatchObject({ status: 'error', http_status: 404, error: 'HTTP 404' });
      expect(rows[2]).toMatchObject({ status: 'error', http_status: null, error: 'timeout' });
      const { rows: runs } = await query(`SELECT status FROM processing_run WHERE kind = 'normalize'`);
      expect(runs).toEqual([{ status: 'done' }]);
    });
  });

  describe('classify', () => {
    const tax = (over = {}) => ({
      themes: [
        {
          slug: 'ia',
          label: 'IA',
          keywords: ['lora'],
          children: [{ slug: 'ia-train', label: 'Train', keywords: ['training'] }],
        },
        { slug: 'photo', label: 'Photo', keywords: ['unsplash'], children: [] },
      ],
      facets: [{ slug: 'type', label: 'Type', values: [{ value: 'article', patterns: [] }] }],
      ...over,
    });
    const useTaxonomy = (t) => {
      config.taxonomyPath = writeTempJson('taxonomy.json', t);
    };
    const prepare = async () => {
      await ingestUrls(['https://example.com/lora-training', 'https://unsplash.com/forest']);
      await normalizePending({ offline: true });
    };

    it('synchronise la taxonomie en base et classe', async () => {
      useTaxonomy(tax());
      await prepare();
      const res = await classifyPending();
      expect(res).toMatchObject({ classified: 2, unthemed: 0 });
      const { rows } = await query(
        `SELECT ui.domain, t.slug, ut.is_primary FROM url_theme ut
           JOIN url_item ui ON ui.id = ut.url_item_id JOIN theme t ON t.id = ut.theme_id
          ORDER BY ui.domain, t.slug`,
      );
      expect(rows).toEqual([
        { domain: 'example.com', slug: 'ia', is_primary: true },
        { domain: 'example.com', slug: 'ia-train', is_primary: false },
        { domain: 'unsplash.com', slug: 'photo', is_primary: true },
      ]);
    });

    it('resynchronise thèmes et facettes quand la taxonomie change, sans doublon', async () => {
      useTaxonomy(tax());
      await prepare();
      await classifyPending();

      useTaxonomy(
        tax({
          themes: [
            { slug: 'ia', label: 'Intelligence artificielle', keywords: ['lora'], children: [] },
            { slug: 'photo', label: 'Photo', keywords: ['unsplash'],
              children: [{ slug: 'ia-train', label: 'Train (déplacé)', keywords: ['forest'] }] },
          ],
        }),
      );
      await classifyPending({ reclassify: true });

      const { rows: themes } = await query(
        `SELECT t.slug, t.label, p.slug AS parent FROM theme t LEFT JOIN theme p ON p.id = t.parent_id ORDER BY t.slug`,
      );
      expect(themes).toEqual([
        { slug: 'ia', label: 'Intelligence artificielle', parent: null },
        { slug: 'ia-train', label: 'Train (déplacé)', parent: 'photo' },
        { slug: 'photo', label: 'Photo', parent: null },
      ]);
      // un seul thème principal par URL, anciennes affectations remplacées
      expect(await count('url_theme', 'is_primary')).toBe(2);
      expect(await count('url_theme', "theme_id = (SELECT id FROM theme WHERE slug = 'ia-train') AND is_primary")).toBe(0);
      expect(await count('url_facet_value')).toBe(2);
    });

    it("ne reclasse pas sans --all", async () => {
      useTaxonomy(tax());
      await prepare();
      await classifyPending();
      const again = await classifyPending();
      expect(again.classified).toBe(0);
    });
  });

  describe('pools', () => {
    const setup = async () => {
      config.taxonomyPath = writeTempJson('taxonomy.json', {
        themes: [{ slug: 'ia', label: 'IA', keywords: ['lora'], children: [] }],
        facets: [],
      });
      await ingestUrls([
        'https://a.com/lora-1',
        'https://b.com/lora-2',
        'https://c.com/lora-3',
        'https://d.com/rien',
      ]);
      await normalizePending({ offline: true });
      await classifyPending();
      // qualité distincte et déterministe pour fixer le rang
      await query(`UPDATE url_item SET quality_score = CASE domain
          WHEN 'a.com' THEN 0.2 WHEN 'b.com' THEN 0.9 WHEN 'c.com' THEN 0.5 ELSE 0.1 END,
          relevance_score = 0`);
    };
    const def = { theme: 'ia', order: 'quality', limit: 10 };

    it('matérialise la sélection avec rang contigu dans l’ordre du critère', async () => {
      await setup();
      await pools.createPool({ slug: 'p', label: 'P', definition: def });
      const res = await pools.refreshPool('p');
      expect(res.count).toBe(3);
      const rows = await pools.showPool('p');
      expect(rows.map((r) => [r.rank, r.domain])).toEqual([[1, 'b.com'], [2, 'c.com'], [3, 'a.com']]);
    });

    it('refresh = delete + insert : rangs repartent de 1, pas de doublon, refreshed_at mis à jour', async () => {
      await setup();
      await pools.createPool({ slug: 'p', definition: def });
      await pools.refreshPool('p');
      const { rows: before } = await query('SELECT refreshed_at FROM pool WHERE slug = $1', ['p']);

      await query(`UPDATE url_item SET quality_score = 0.95 WHERE domain = 'a.com'`);
      const res = await pools.refreshPool('p');
      expect(res.count).toBe(3);
      expect(await count('pool_item')).toBe(3);
      const rows = await pools.showPool('p');
      expect(rows.map((r) => [r.rank, r.domain])).toEqual([[1, 'a.com'], [2, 'b.com'], [3, 'c.com']]);
      const { rows: after } = await query('SELECT refreshed_at FROM pool WHERE slug = $1', ['p']);
      expect(after[0].refreshed_at.getTime()).toBeGreaterThanOrEqual(before[0].refreshed_at.getTime());
    });

    it('une définition modifiée (createPool sur un slug existant) change la sélection au refresh', async () => {
      await setup();
      await pools.createPool({ slug: 'p', definition: def });
      await pools.refreshPool('p');
      await pools.createPool({ slug: 'p', definition: { ...def, limit: 1 } });
      expect((await pools.refreshPool('p')).count).toBe(1);
      expect(await count('pool_item')).toBe(1);
      expect(await count('pool')).toBe(1);
    });

    it('rejette une définition invalide et un slug inconnu', async () => {
      await expect(pools.createPool({ slug: 'x', definition: { bogus: 1 } })).rejects.toThrow(/Critère inconnu/);
      await expect(pools.refreshPool('absent')).rejects.toThrow(/Pool inconnu/);
      expect(await count('pool')).toBe(0);
    });

    it("l'export reflète le pool matérialisé", async () => {
      await setup();
      await pools.createPool({ slug: 'p', definition: def });
      await pools.refreshPool('p');
      const { formatPool } = await import('../../src/pools/export.js');
      const out = JSON.parse(formatPool(await pools.loadPoolForExport('p'), 'json'));
      expect(out.pool.definition).toEqual(def);
      expect(out.items.map((i) => i.domain)).toEqual(['b.com', 'c.com', 'a.com']);
    });
  });
});
