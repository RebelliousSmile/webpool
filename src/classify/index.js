import fs from 'node:fs';
import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import { withRun } from '../run.js';
import { classifyItem } from './classifier.js';
import { USAGE_FACET, loadQualifications } from '../domains/index.js';

export function loadTaxonomy(path = config.taxonomyPath) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

// Un slug identifie un thème (racine ou sous-thème) ou une facette : un doublon
// rendrait l'upsert ambigu. Validation avant toute écriture.
function assertUniqueSlugs(taxonomy) {
  const check = (slugs, kind) => {
    const seen = new Set();
    for (const slug of slugs) {
      if (seen.has(slug)) throw new Error(`Taxonomie invalide : slug de ${kind} en double « ${slug} »`);
      seen.add(slug);
    }
    return [...seen];
  };
  const themes = check(
    (taxonomy.themes ?? []).flatMap((t) => [t.slug, ...(t.children ?? []).map((c) => c.slug)]),
    'thème',
  );
  const facets = check((taxonomy.facets ?? []).map((f) => f.slug), 'facette');
  return { themes, facets };
}

// La config JSON est la source de vérité : thèmes et facettes sont upsertés en
// base avant classification, les absents supprimés (avec leurs affectations,
// par cascade), et les slugs → ids mémorisés. Le tout dans une transaction.
async function syncTaxonomy(taxonomy) {
  const slugs = assertUniqueSlugs(taxonomy);
  return withTransaction(async (client) => {
    const themeIds = new Map();
    for (const theme of taxonomy.themes ?? []) {
      const { rows } = await client.query(
        `INSERT INTO theme (slug, label, parent_id) VALUES ($1, $2, NULL)
         ON CONFLICT (slug) DO UPDATE SET label = EXCLUDED.label, parent_id = NULL
         RETURNING id`,
        [theme.slug, theme.label],
      );
      themeIds.set(theme.slug, rows[0].id);
      for (const child of theme.children ?? []) {
        const { rows: childRows } = await client.query(
          `INSERT INTO theme (slug, label, parent_id) VALUES ($1, $2, $3)
           ON CONFLICT (slug) DO UPDATE SET label = EXCLUDED.label, parent_id = EXCLUDED.parent_id
           RETURNING id`,
          [child.slug, child.label, rows[0].id],
        );
        themeIds.set(child.slug, childRows[0].id);
      }
    }
    // theme.parent_id est sans cascade : détacher les absents avant de les supprimer.
    await client.query('UPDATE theme SET parent_id = NULL WHERE slug <> ALL($1)', [slugs.themes]);
    await client.query('DELETE FROM theme WHERE slug <> ALL($1)', [slugs.themes]);

    const facetIds = new Map();
    for (const facet of taxonomy.facets ?? []) {
      const { rows } = await client.query(
        `INSERT INTO facet_definition (slug, label) VALUES ($1, $2)
         ON CONFLICT (slug) DO UPDATE SET label = EXCLUDED.label
         RETURNING id`,
        [facet.slug, facet.label],
      );
      facetIds.set(facet.slug, rows[0].id);
    }
    await client.query('DELETE FROM facet_definition WHERE slug <> ALL($1)', [slugs.facets]);
    return { themeIds, facetIds };
  });
}

// Un lot entier en une transaction et un nombre fixe de requêtes : les
// affectations sont remplacées par des inserts multi-lignes (unnest).
async function persistBatch(classified, ids, runId) {
  if (classified.length === 0) return;
  const itemIds = classified.map(({ item }) => item.id);
  const themes = { item: [], theme: [], primary: [], score: [] };
  const facets = { item: [], facet: [], value: [] };
  const pushTheme = (itemId, slug, primary, score) => {
    themes.item.push(itemId);
    themes.theme.push(ids.themeIds.get(slug));
    themes.primary.push(primary);
    themes.score.push(score);
  };
  for (const { item, result } of classified) {
    if (result.primary) {
      pushTheme(item.id, result.primary, true, result.primaryScore);
      for (const sub of result.subthemes) pushTheme(item.id, sub.slug, false, sub.score);
    }
    for (const [facetSlug, value] of Object.entries(result.facets)) {
      facets.item.push(item.id);
      facets.facet.push(ids.facetIds.get(facetSlug));
      facets.value.push(value);
    }
  }

  await withTransaction(async (client) => {
    await client.query('DELETE FROM url_theme WHERE url_item_id = ANY($1)', [itemIds]);
    await client.query('DELETE FROM url_facet_value WHERE url_item_id = ANY($1)', [itemIds]);
    await client.query(
      `INSERT INTO url_theme (url_item_id, theme_id, is_primary, score)
       SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::boolean[], $4::numeric[])`,
      [themes.item, themes.theme, themes.primary, themes.score],
    );
    await client.query(
      `INSERT INTO url_facet_value (url_item_id, facet_id, value)
       SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::text[])`,
      [facets.item, facets.facet, facets.value],
    );
    await client.query(
      `UPDATE url_item ui
          SET status = 'classified', relevance_score = s.relevance, confidence_score = s.confidence,
              quality_score = s.quality, classified_at = now(), classify_run_id = $5
         FROM unnest($1::bigint[], $2::numeric[], $3::numeric[], $4::numeric[])
              AS s(id, relevance, confidence, quality)
        WHERE ui.id = s.id`,
      [
        itemIds,
        classified.map(({ result }) => result.scores.relevance),
        classified.map(({ result }) => result.scores.confidence),
        classified.map(({ result }) => result.scores.quality),
        runId,
      ],
    );
  });
}

// US-05 : classe les url_item en statut 'normalized' (ou reclasse avec --all).
export async function classifyPending({ limit = 100, reclassify = false, taxonomy = loadTaxonomy() } = {}) {
  return withRun('classify', { limit, reclassify }, async (runId) => {
    const ids = await syncTaxonomy(taxonomy);
    const statuses = reclassify ? ['normalized', 'classified'] : ['normalized'];
    const fetchBatch = async (afterId) =>
      (
        await query(
          `SELECT ui.id, ui.canonical_url, ui.domain, ui.title,
                  coalesce(array_agg(DISTINCT us.query) FILTER (WHERE us.query IS NOT NULL), '{}') AS queries
             FROM url_item ui
             LEFT JOIN url_source us ON us.url_item_id = ui.id
            WHERE ui.status = ANY($1) AND ui.id > $3
            GROUP BY ui.id
            ORDER BY ui.id
            LIMIT $2`,
          [statuses, limit, afterId],
        )
      ).rows;

    let classified = 0;
    let unthemed = 0;
    // Sans --all : un lot de `limit`. Avec --all : tout le corpus, par lots de
    // `limit`, curseur sur l'id (les items reclassés restent sélectionnables).
    for (let afterId = 0; ; ) {
      const items = await fetchBatch(afterId);
      const batch = items.map((item) => ({
        item,
        result: classifyItem(
          {
            canonicalUrl: item.canonical_url,
            domain: item.domain,
            title: item.title,
            queries: item.queries,
          },
          taxonomy,
        ),
      }));
      // La qualification du registre l'emporte sur les motifs de la taxonomie.
      if (ids.facetIds.has(USAGE_FACET)) {
        const qualified = await loadQualifications(items.map((item) => item.domain));
        for (const { item, result } of batch) {
          if (qualified.has(item.domain)) result.facets[USAGE_FACET] = qualified.get(item.domain);
        }
      }
      await persistBatch(batch, ids, runId);
      classified += batch.length;
      unthemed += batch.filter(({ result }) => !result.primary).length;
      if (!reclassify || items.length < limit) break;
      afterId = items.at(-1).id;
    }

    return { classified, unthemed };
  });
}
