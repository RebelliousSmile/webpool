import fs from 'node:fs';
import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import { startRun, finishRun } from '../run.js';
import { classifyItem } from './classifier.js';

export function loadTaxonomy(path = config.taxonomyPath) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

// La config JSON est la source de vérité : thèmes et facettes sont upsertés en
// base avant classification, et les slugs → ids mémorisés.
async function syncTaxonomy(taxonomy) {
  const themeIds = new Map();
  for (const theme of taxonomy.themes ?? []) {
    const { rows } = await query(
      `INSERT INTO theme (slug, label) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET label = EXCLUDED.label
       RETURNING id`,
      [theme.slug, theme.label],
    );
    themeIds.set(theme.slug, rows[0].id);
    for (const child of theme.children ?? []) {
      const { rows: childRows } = await query(
        `INSERT INTO theme (slug, label, parent_id) VALUES ($1, $2, $3)
         ON CONFLICT (slug) DO UPDATE SET label = EXCLUDED.label, parent_id = EXCLUDED.parent_id
         RETURNING id`,
        [child.slug, child.label, rows[0].id],
      );
      themeIds.set(child.slug, childRows[0].id);
    }
  }

  const facetIds = new Map();
  for (const facet of taxonomy.facets ?? []) {
    const { rows } = await query(
      `INSERT INTO facet_definition (slug, label) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET label = EXCLUDED.label
       RETURNING id`,
      [facet.slug, facet.label],
    );
    facetIds.set(facet.slug, rows[0].id);
  }
  return { themeIds, facetIds };
}

async function persistClassification(item, result, ids, runId) {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM url_theme WHERE url_item_id = $1', [item.id]);
    await client.query('DELETE FROM url_facet_value WHERE url_item_id = $1', [item.id]);

    if (result.primary) {
      await client.query(
        `INSERT INTO url_theme (url_item_id, theme_id, is_primary, score) VALUES ($1, $2, TRUE, $3)`,
        [item.id, ids.themeIds.get(result.primary), result.primaryScore],
      );
      for (const sub of result.subthemes) {
        await client.query(
          `INSERT INTO url_theme (url_item_id, theme_id, is_primary, score) VALUES ($1, $2, FALSE, $3)`,
          [item.id, ids.themeIds.get(sub.slug), sub.score],
        );
      }
    }

    for (const [facetSlug, value] of Object.entries(result.facets)) {
      await client.query(
        `INSERT INTO url_facet_value (url_item_id, facet_id, value) VALUES ($1, $2, $3)`,
        [item.id, ids.facetIds.get(facetSlug), value],
      );
    }

    await client.query(
      `UPDATE url_item
          SET status = 'classified', relevance_score = $2, confidence_score = $3,
              quality_score = $4, classified_at = now(), classify_run_id = $5
        WHERE id = $1`,
      [item.id, result.scores.relevance, result.scores.confidence, result.scores.quality, runId],
    );
  });
}

// US-05 : classe les url_item en statut 'normalized' (ou reclasse avec --all).
export async function classifyPending({ limit = 100, reclassify = false } = {}) {
  const taxonomy = loadTaxonomy();
  const runId = await startRun('classify', { limit, reclassify });
  try {
    const ids = await syncTaxonomy(taxonomy);
    const statuses = reclassify ? ['normalized', 'classified'] : ['normalized'];
    const { rows: items } = await query(
      `SELECT ui.id, ui.canonical_url, ui.domain, ui.title,
              coalesce(array_agg(DISTINCT us.query) FILTER (WHERE us.query IS NOT NULL), '{}') AS queries
         FROM url_item ui
         LEFT JOIN url_source us ON us.url_item_id = ui.id
        WHERE ui.status = ANY($1)
        GROUP BY ui.id
        ORDER BY ui.id
        LIMIT $2`,
      [statuses, limit],
    );

    let classified = 0;
    let unthemed = 0;
    for (const item of items) {
      const result = classifyItem(
        {
          canonicalUrl: item.canonical_url,
          domain: item.domain,
          title: item.title,
          queries: item.queries,
        },
        taxonomy,
      );
      await persistClassification(item, result, ids, runId);
      classified += 1;
      if (!result.primary) unthemed += 1;
    }

    await finishRun(runId, 'done', { classified, unthemed });
    return { runId, classified, unthemed };
  } catch (err) {
    await finishRun(runId, 'failed', { error: String(err.message ?? err) });
    throw err;
  }
}
