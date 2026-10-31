import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSchema, dbAvailable, dbRequired, dropSchema, resetData, writeTempJson } from './helpers.js';

const available = await dbAvailable();
if (!available && dbRequired()) {
  throw new Error('[integration] PostgreSQL injoignable alors que la suite est requise (CI ou WEBPOOL_IT_REQUIRED).');
}
if (!available) {
  console.warn('[integration] PostgreSQL injoignable : suite ignorée (pnpm db:up pour la lancer).');
}

describe.skipIf(!available)('pipeline sur PostgreSQL', () => {
  let db;
  let ingest;
  let normalizePending;
  let classifyPending;
  let pools;
  const { query } = { query: (...a) => db.query(...a) };

  beforeAll(async () => {
    await createSchema();
    db = await import('../../src/db.js');
    ({ ingest } = await import('../../src/ingest/index.js'));
    ({ normalizePending } = await import('../../src/normalize/index.js'));
    ({ classifyPending } = await import('../../src/classify/index.js'));
    pools = await import('../../src/pools/index.js');
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

    it('insère un lot en écritures groupées : 50 résultats dont 10 connus', async () => {
      const urls = Array.from({ length: 50 }, (_, i) => `https://lot.example/${i}`);
      await ingestUrls(urls.slice(0, 10), 'avant');
      const res = await ingestUrls(urls, 'lot');
      expect(res).toMatchObject({ inserted: 40, existing: 10, total: 50 });
      expect(await count('url_item')).toBe(50);
      expect(await count('url_source', "query = 'lot'")).toBe(50);
      const { rows } = await query(`SELECT serp_rank FROM url_source WHERE query = 'lot' ORDER BY serp_rank`);
      expect(rows.map((r) => r.serp_rank)).toEqual(urls.map((_, i) => i + 1));
    });

    it('une URL répétée dans la SERP donne un item et deux sources', async () => {
      const res = await ingestUrls(['https://a.com/x', 'https://a.com/x']);
      expect(res).toMatchObject({ inserted: 1, existing: 1, total: 2 });
      expect(await count('url_item')).toBe(1);
      expect(await count('url_source')).toBe(2);
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

    it('réingérer une variante doublon trace la requête sur la survivante', async () => {
      const variant = 'https://www.unsplash.com/s/photos/forest?utm_source=x';
      await ingestUrls([variant, 'https://unsplash.com/s/photos/forest'], 'forest');
      await normalizePending({ offline: true });
      const { rows: dup } = await query(`SELECT id, duplicate_of FROM url_item WHERE status = 'duplicate'`);

      const again = await ingestUrls([variant], 'forêt lora');
      expect(again).toMatchObject({ inserted: 0, existing: 1 });
      expect(await count('url_source', `url_item_id = ${dup[0].id}`)).toBe(0);
      const { rows } = await query('SELECT query FROM url_source WHERE url_item_id = $1 ORDER BY id', [
        dup[0].duplicate_of,
      ]);
      expect(rows.map((r) => r.query)).toEqual(['forest', 'forest', 'forêt lora']);
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

    it("ignore un canonical d'un autre domaine : pas de fusion", async () => {
      await ingestUrls(['https://a.example/page', 'https://b.example/cible']);
      const fetcher = async (url) => ({
        finalUrl: url,
        httpStatus: 200,
        html: url.includes('a.example')
          ? '<head><link rel="canonical" href="https://b.example/cible"></head>'
          : '<head><title>B</title></head>',
      });
      const res = await normalizePending({ fetcher });
      expect(res).toMatchObject({ normalized: 2, duplicate: 0, error: 0 });
      const { rows } = await query('SELECT canonical_url FROM url_item ORDER BY id');
      expect(rows.map((r) => r.canonical_url)).toEqual(['https://a.example/page', 'https://b.example/cible']);
    });

    it('par blocs : mêmes comptes qu’en un seul bloc', async () => {
      await ingestUrls([
        'https://www.a.com/x?utm_source=t',
        'https://a.com/x',
        'https://b.com/y',
        'https://c.com/z',
        'https://a.com/x#frag',
      ]);
      const res = await normalizePending({ offline: true, chunkSize: 2 });
      expect(res).toMatchObject({ normalized: 3, duplicate: 2, error: 0, total: 5 });
    });

    it('un bloc est écrit avant le réseau du suivant ; une panne du bloc 2 laisse le bloc 1 intact', async () => {
      const urls = ['https://a.com/1', 'https://b.com/2', 'https://c.com/3', 'https://d.com/4', 'https://e.com/5'];
      await ingestUrls(urls);
      let seenWhenBlock2Starts = null;
      const fetcher = async (url) => {
        const i = urls.indexOf(url);
        if (i === 2) {
          const { rows } = await query('SELECT status FROM url_item ORDER BY id LIMIT 2');
          seenWhenBlock2Starts = rows.map((r) => r.status);
        }
        if (i === 2 || i === 3) throw new Error('réseau injoignable');
        return { finalUrl: url, httpStatus: 200, html: '<head><title>ok</title></head>' };
      };
      const res = await normalizePending({ fetcher, chunkSize: 2 });
      expect(res).toMatchObject({ normalized: 3, duplicate: 0, error: 2, total: 5 });
      expect(seenWhenBlock2Starts).toEqual(['normalized', 'normalized']);
      const { rows } = await query('SELECT status FROM url_item ORDER BY id');
      expect(rows.map((r) => r.status)).toEqual(['normalized', 'normalized', 'error', 'error', 'normalized']);
    });

    it('refuse un hôte non public sans émettre de requête', async () => {
      await ingestUrls(['http://127.0.0.1/admin', 'http://169.254.169.254/latest', 'http://[::1]/']);
      let calls = 0;
      const fetchImpl = async () => {
        calls += 1;
        return new Response('<head></head>', { headers: { 'content-type': 'text/html' } });
      };
      const res = await normalizePending({ fetchImpl });
      expect(res).toMatchObject({ normalized: 0, error: 3 });
      expect(calls).toBe(0);
      const { rows } = await query('SELECT status, error FROM url_item');
      for (const row of rows) expect(row).toMatchObject({ status: 'error', error: expect.stringMatching(/hôte refusé/) });
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
    // La taxonomie est injectée : config est gelée, aucun test ne la modifie.
    let taxonomy;
    const useTaxonomy = (t) => {
      taxonomy = t;
    };
    const classify = (opts = {}) => classifyPending({ taxonomy, ...opts });
    const prepare = async () => {
      await ingestUrls(['https://example.com/lora-training', 'https://unsplash.com/forest']);
      await normalizePending({ offline: true });
    };

    it('synchronise la taxonomie en base et classe', async () => {
      useTaxonomy(tax());
      await prepare();
      const res = await classify();
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
      await classify();

      useTaxonomy(
        tax({
          themes: [
            { slug: 'ia', label: 'Intelligence artificielle', keywords: ['lora'], children: [] },
            { slug: 'photo', label: 'Photo', keywords: ['unsplash'],
              children: [{ slug: 'ia-train', label: 'Train (déplacé)', keywords: ['forest'] }] },
          ],
        }),
      );
      await classify({ reclassify: true });

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
      await classify();
      const again = await classify();
      expect(again.classified).toBe(0);
    });

    it('--all reclasse tout le corpus au-delà de limit', async () => {
      useTaxonomy(tax());
      await ingestUrls(['https://a.com/lora', 'https://b.com/lora', 'https://c.com/x', 'https://d.com/x', 'https://e.com/x']);
      await normalizePending({ offline: true });
      await classify();
      const res = await classify({ reclassify: true, limit: 2 });
      expect(res.classified).toBe(5);
      const { rows } = await query(`SELECT detail FROM processing_run WHERE kind = 'classify' ORDER BY id DESC LIMIT 1`);
      expect(rows[0].detail).toMatchObject({ classified: 5 });
      expect(await count('url_item', `classify_run_id = ${res.runId}`)).toBe(5);
    });

    it('supprime un thème et une facette retirés du JSON, avec leurs affectations', async () => {
      useTaxonomy(tax());
      await prepare();
      await classify();
      useTaxonomy(tax({ themes: [{ slug: 'photo', label: 'Photo', keywords: ['unsplash'], children: [] }], facets: [] }));
      await classify({ reclassify: true });
      const { rows } = await query('SELECT slug FROM theme ORDER BY slug');
      expect(rows).toEqual([{ slug: 'photo' }]);
      expect(await count('url_theme')).toBe(1);
      expect(await count('facet_definition')).toBe(0);
      expect(await count('url_facet_value')).toBe(0);
    });

    it('rejette un slug en double sans rien écrire, run en failed', async () => {
      useTaxonomy(
        tax({
          themes: [
            { slug: 'ia', label: 'IA', keywords: ['lora'], children: [{ slug: 'photo', label: 'X', keywords: [] }] },
            { slug: 'photo', label: 'Photo', keywords: ['unsplash'], children: [] },
          ],
        }),
      );
      await prepare();
      await expect(classify()).rejects.toThrow(/slug de thème en double « photo »/);
      expect(await count('theme')).toBe(0);
      expect(await count('facet_definition')).toBe(0);
      const { rows } = await query(`SELECT status FROM processing_run WHERE kind = 'classify'`);
      expect(rows).toEqual([{ status: 'failed' }]);
    });
  });

  describe('pools', () => {
    const setup = async () => {
      await ingestUrls([
        'https://a.com/lora-1',
        'https://b.com/lora-2',
        'https://c.com/lora-3',
        'https://d.com/rien',
      ]);
      await normalizePending({ offline: true });
      await classifyPending({
        taxonomy: { themes: [{ slug: 'ia', label: 'IA', keywords: ['lora'], children: [] }], facets: [] },
      });
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

    it('createPool sur un slug existant échoue sans --force et laisse la définition intacte', async () => {
      await setup();
      await pools.createPool({ slug: 'p', definition: def });
      await expect(pools.createPool({ slug: 'p', definition: { ...def, limit: 1 } })).rejects.toThrow(
        /Pool existant : p/,
      );
      const { rows } = await query('SELECT definition FROM pool WHERE slug = $1', ['p']);
      expect(rows[0].definition).toEqual(def);
      expect((await pools.refreshPool('p')).count).toBe(3);
    });

    it('une définition modifiée (createPool --force sur un slug existant) change la sélection au refresh', async () => {
      await setup();
      await pools.createPool({ slug: 'p', definition: def });
      await pools.refreshPool('p');
      await pools.createPool({ slug: 'p', definition: { ...def, limit: 1 }, force: true });
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

    it('rarity : un domaine à 1 URL précède un domaine massif, ordre stable d’un refresh à l’autre', async () => {
      const massive = Array.from({ length: 10 }, (_, i) => `https://big.com/lora-${i}`);
      await ingestUrls([...massive, 'https://rare.com/lora', 'https://mid.com/lora-1', 'https://mid.com/lora-2']);
      await normalizePending({ offline: true });
      await classifyPending({
        taxonomy: { themes: [{ slug: 'ia', label: 'IA', keywords: ['lora'], children: [] }], facets: [] },
      });
      // big.com a la meilleure qualité : seule la rareté le fait reculer
      await query(`UPDATE url_item SET quality_score = CASE domain WHEN 'big.com' THEN 0.9 ELSE 0.1 END`);
      await pools.createPool({ slug: 'r', definition: { theme: 'ia', order: 'rarity', limit: 20 } });

      await pools.refreshPool('r');
      const first = await pools.showPool('r');
      expect(first.map((r) => r.domain).slice(0, 3)).toEqual(['rare.com', 'mid.com', 'mid.com']);
      expect(first.slice(3).every((r) => r.domain === 'big.com')).toBe(true);
      expect(Number(first[0].score)).toBe(1);
      expect(Number(first[3].score)).toBeCloseTo(1 / Math.sqrt(10), 3);

      await pools.refreshPool('r');
      expect((await pools.showPool('r')).map((r) => r.canonical_url)).toEqual(first.map((r) => r.canonical_url));
    });

    it('recent : ordre par découverte inchangé, score décroissant avec l’âge', async () => {
      await setup();
      await query(`UPDATE url_item SET first_seen_at = now() - (CASE domain
          WHEN 'a.com' THEN 0 WHEN 'b.com' THEN 2 ELSE 9 END) * interval '1 day'`);
      await pools.createPool({ slug: 'n', definition: { theme: 'ia', order: 'recent' } });
      await pools.refreshPool('n');
      const rows = await pools.showPool('n');
      expect(rows.map((r) => r.domain)).toEqual(['a.com', 'b.com', 'c.com']);
      const scores = rows.map((r) => Number(r.score));
      expect(scores[0]).toBeCloseTo(1, 3);
      expect(scores[1]).toBeCloseTo(1 / 3, 3);
      expect(scores[2]).toBeCloseTo(1 / 10, 3);
    });

    it('refuse une facette absente de la base, à la création comme au refresh', async () => {
      await setup();
      await expect(pools.createPool({ slug: 'p', definition: { facets: { licence: 'libre' } } })).rejects.toThrow(
        /Facette inconnue dans la définition : licence/,
      );
      await query(`INSERT INTO pool (slug, label, definition) VALUES ('old', 'old', '{"facets": {"licence": "libre"}}')`);
      await expect(pools.refreshPool('old')).rejects.toThrow(/Facette inconnue dans la définition : licence/);
    });
  });

  describe('registre des domaines', () => {
    let domains;
    beforeAll(async () => {
      domains = await import('../../src/domains/index.js');
    });
    const usageOf = async (domain) =>
      (
        await query(
          `SELECT ufv.value FROM url_facet_value ufv
             JOIN facet_definition fd ON fd.id = ufv.facet_id AND fd.slug = 'usage-commercial'
             JOIN url_item ui ON ui.id = ufv.url_item_id
            WHERE ui.domain = $1 ORDER BY ui.id`,
          [domain],
        )
      ).rows.map((r) => r.value);

    it('ingest enregistre chaque domaine une fois, avec sa première requête', async () => {
      const first = await ingestUrls(['https://www.a.com/1', 'https://a.com/2', 'https://b.com/1', 'mailto:x@c.com'], 'q1');
      expect(first.newDomains).toBe(2);
      const second = await ingestUrls(['https://b.com/2', 'https://c.com/1'], 'q2');
      expect(second.newDomains).toBe(1);
      const { rows } = await query('SELECT domain, first_query, usage_commercial FROM domain_profile ORDER BY domain');
      expect(rows).toEqual([
        { domain: 'a.com', first_query: 'q1', usage_commercial: null },
        { domain: 'b.com', first_query: 'q1', usage_commercial: null },
        { domain: 'c.com', first_query: 'q2', usage_commercial: null },
      ]);
    });

    it('normalize ajoute le domaine atteint par redirection', async () => {
      await ingestUrls(['https://short.link/x'], 'courte');
      const fetcher = async () => ({ finalUrl: 'https://cible.org/page', httpStatus: 200, html: '' });
      await normalizePending({ fetcher });
      const { rows } = await query('SELECT domain, first_query FROM domain_profile ORDER BY domain');
      expect(rows).toEqual([
        { domain: 'cible.org', first_query: 'courte' },
        { domain: 'short.link', first_query: 'courte' },
      ]);
    });

    it('domain list : URLs comptées, filtre à qualifier', async () => {
      await ingestUrls(['https://a.com/1', 'https://a.com/2', 'https://b.com/1']);
      await normalizePending({ offline: true });
      await query(`UPDATE domain_profile SET usage_commercial = 'libre' WHERE domain = 'b.com'`);
      const all = await domains.listDomains();
      expect(all.map((d) => [d.domain, d.urls, d.usage_commercial])).toEqual([
        ['a.com', 2, null],
        ['b.com', 1, 'libre'],
      ]);
      expect((await domains.listDomains({ toQualify: true })).map((d) => d.domain)).toEqual(['a.com']);
    });

    it('la qualification réécrit la facette sans reclasser et survit à classify --all', async () => {
      await ingestUrls(['https://unsplash.com/photos/x', 'https://blue-wind.net/a', 'https://blue-wind.net/b']);
      await normalizePending({ offline: true });
      await classifyPending();
      expect(await usageOf('unsplash.com')).toEqual(['libre']);
      expect(await usageOf('blue-wind.net')).toEqual(['a-qualifier', 'a-qualifier']);

      const res = await domains.qualifyDomain({ domain: 'www.Blue-Wind.net', usage: 'sous-conditions', note: 'CC BY' });
      expect(res).toEqual({ domain: 'blue-wind.net', usage: 'sous-conditions', rewritten: 2 });
      expect(await usageOf('blue-wind.net')).toEqual(['sous-conditions', 'sous-conditions']);

      await domains.qualifyDomain({ domain: 'unsplash.com', usage: 'payant' });
      await classifyPending({ reclassify: true });
      expect(await usageOf('unsplash.com')).toEqual(['payant']);
      expect(await usageOf('blue-wind.net')).toEqual(['sous-conditions', 'sous-conditions']);
      const { rows } = await query(`SELECT note, reviewed_at IS NOT NULL AS reviewed FROM domain_profile WHERE domain = 'blue-wind.net'`);
      expect(rows).toEqual([{ note: 'CC BY', reviewed: true }]);
    });

    it('base jamais classée : seul le registre est écrit', async () => {
      await ingestUrls(['https://a.com/1']);
      const res = await domains.qualifyDomain({ domain: 'a.com', usage: 'libre' });
      expect(res.rewritten).toBeNull();
      expect(await count('domain_profile', "usage_commercial = 'libre'")).toBe(1);
    });

    it('domaine absent ou valeur invalide : erreur, rien écrit', async () => {
      await ingestUrls(['https://a.com/1']);
      await expect(domains.qualifyDomain({ domain: 'absent.org', usage: 'libre' })).rejects.toThrow(
        /Domaine inconnu du registre : absent\.org/,
      );
      await expect(domains.qualifyDomain({ domain: 'a.com', usage: 'gratuit' })).rejects.toThrow(/--usage invalide/);
      expect(await count('domain_profile', 'usage_commercial IS NOT NULL')).toBe(0);
    });
  });
});
