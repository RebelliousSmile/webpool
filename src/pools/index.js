import fs from 'node:fs';
import { query, withTransaction } from '../db.js';
import { startRun, finishRun } from '../run.js';
import { buildPoolQuery } from './criteria.js';

export async function createPool({ slug, label, definitionFile, definition }) {
  const def = definition ?? JSON.parse(fs.readFileSync(definitionFile, 'utf8'));
  buildPoolQuery(def); // valide la définition avant insertion
  const { rows } = await query(
    `INSERT INTO pool (slug, label, definition) VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE SET label = EXCLUDED.label, definition = EXCLUDED.definition
     RETURNING id`,
    [slug, label ?? slug, JSON.stringify(def)],
  );
  return rows[0].id;
}

// US-06 : rematérialise le pool depuis sa définition. L'ordre de sélection est
// conservé dans pool_item.rank.
export async function refreshPool(slug) {
  const { rows } = await query('SELECT id, definition FROM pool WHERE slug = $1', [slug]);
  if (rows.length === 0) throw new Error(`Pool inconnu : ${slug}`);
  const pool = rows[0];

  const runId = await startRun('pool', { slug });
  try {
    const { text, values } = buildPoolQuery(pool.definition);
    const { rows: selected } = await query(text, values);

    await withTransaction(async (client) => {
      await client.query('DELETE FROM pool_item WHERE pool_id = $1', [pool.id]);
      for (const [i, row] of selected.entries()) {
        await client.query(
          `INSERT INTO pool_item (pool_id, url_item_id, rank, score) VALUES ($1, $2, $3, $4)`,
          [pool.id, row.id, i + 1, row.pool_score],
        );
      }
      await client.query(
        'UPDATE pool SET refreshed_at = now(), refresh_run_id = $2 WHERE id = $1',
        [pool.id, runId],
      );
    });

    await finishRun(runId, 'done', { count: selected.length });
    return { runId, count: selected.length };
  } catch (err) {
    await finishRun(runId, 'failed', { error: String(err.message ?? err) });
    throw err;
  }
}

export async function listPools() {
  const { rows } = await query(
    `SELECT p.slug, p.label, p.refreshed_at, count(pi.url_item_id)::int AS items
       FROM pool p LEFT JOIN pool_item pi ON pi.pool_id = p.id
      GROUP BY p.id ORDER BY p.slug`,
  );
  return rows;
}

export async function showPool(slug) {
  const { rows } = await query(
    `SELECT pi.rank, pi.score, ui.canonical_url, ui.domain, ui.title
       FROM pool p
       JOIN pool_item pi ON pi.pool_id = p.id
       JOIN url_item ui ON ui.id = pi.url_item_id
      WHERE p.slug = $1
      ORDER BY pi.rank`,
    [slug],
  );
  return rows;
}
