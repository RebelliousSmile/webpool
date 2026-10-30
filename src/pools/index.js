import fs from 'node:fs';
import { query, withTransaction } from '../db.js';
import { withRun } from '../run.js';
import { buildPoolQuery } from './criteria.js';

// Une facette absente de la taxonomie en base viderait le pool sans bruit
// (facette renommée, base jamais classée) : refus explicite.
async function assertKnownFacets(def) {
  const slugs = Object.keys(def.facets ?? {});
  if (slugs.length === 0) return;
  const { rows } = await query('SELECT slug FROM facet_definition ORDER BY slug');
  const known = rows.map((r) => r.slug);
  const missing = slugs.filter((s) => !known.includes(s));
  if (missing.length > 0) {
    throw new Error(
      `Facette inconnue dans la définition : ${missing.join(', ')} (connues : ${known.join(', ') || 'aucune, lancer classify'})`,
    );
  }
}

// Un slug existant n'est remplacé qu'avec `force` : pas d'écrasement silencieux.
export async function createPool({ slug, label, definitionFile, definition, force = false }) {
  const def = definition ?? JSON.parse(fs.readFileSync(definitionFile, 'utf8'));
  buildPoolQuery(def); // valide la définition avant insertion
  await assertKnownFacets(def);
  const { rows } = await query(
    `INSERT INTO pool (slug, label, definition) VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO ${force ? 'UPDATE SET label = EXCLUDED.label, definition = EXCLUDED.definition' : 'NOTHING'}
     RETURNING id`,
    [slug, label ?? slug, JSON.stringify(def)],
  );
  if (rows.length === 0) throw new Error(`Pool existant : ${slug} (utiliser --force pour le remplacer)`);
  return rows[0].id;
}

// US-06 : rematérialise le pool depuis sa définition. L'ordre de sélection est
// conservé dans pool_item.rank.
export async function refreshPool(slug) {
  const { rows } = await query('SELECT id, definition FROM pool WHERE slug = $1', [slug]);
  if (rows.length === 0) throw new Error(`Pool inconnu : ${slug}`);
  const pool = rows[0];

  await assertKnownFacets(pool.definition);
  return withRun('pool', { slug }, async (runId) => {
    const { text, values } = buildPoolQuery(pool.definition);
    const { rows: selected } = await query(text, values);

    await withTransaction(async (client) => {
      await client.query('DELETE FROM pool_item WHERE pool_id = $1', [pool.id]);
      // Le rang est la position dans la sélection (WITH ORDINALITY), en une requête.
      await client.query(
        `INSERT INTO pool_item (pool_id, url_item_id, rank, score)
         SELECT $1, t.id, t.rank, t.score
           FROM unnest($2::bigint[], $3::numeric[]) WITH ORDINALITY AS t(id, score, rank)`,
        [pool.id, selected.map((r) => r.id), selected.map((r) => r.pool_score)],
      );
      await client.query(
        'UPDATE pool SET refreshed_at = now(), refresh_run_id = $2 WHERE id = $1',
        [pool.id, runId],
      );
    });

    return { count: selected.length };
  });
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

// US-12 : pool + éléments dans l'ordre de rang, pour l'export.
export async function loadPoolForExport(slug) {
  const { rows } = await query(
    'SELECT slug, label, definition, refreshed_at FROM pool WHERE slug = $1',
    [slug],
  );
  if (rows.length === 0) throw new Error(`Pool inconnu : ${slug}`);
  return { pool: rows[0], items: await showPool(slug) };
}
