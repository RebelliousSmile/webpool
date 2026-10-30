import fs from 'node:fs';
import { config } from '../config.js';
import { query } from '../db.js';
import { withRun } from '../run.js';
import { ingest, providers } from '../ingest/index.js';
import { isRested, nextState, priority, selectQueries } from './frontier.js';

export const QUERY_STATUSES = ['active', 'exhausted', 'paused'];

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertProvider(provider) {
  if (!providers[provider]) {
    throw new Error(`Provider inconnu : ${provider} (disponibles : ${Object.keys(providers).join(', ')})`);
  }
}

// Valide une entrée de requête ; `where` situe l'erreur (index dans un fichier).
function checkEntry(entry, where = '') {
  if (!entry || typeof entry.query !== 'string' || !entry.query.trim()) {
    throw new Error(`Requête invalide${where} : champ query requis`);
  }
  assertProvider(entry.provider);
  const tags = entry.tags ?? [];
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
    throw new Error(`Requête invalide${where} : tags doit être une liste de chaînes`);
  }
  return { provider: entry.provider, query: entry.query.trim(), tags };
}

export function parseTags(raw) {
  if (!raw) return [];
  return raw.split(',').map((t) => t.trim()).filter(Boolean);
}

// Une requête déjà présente pour ce provider est refusée, sans doublon.
export async function addQuery({ provider, query: text, tags = [] }) {
  const entry = checkEntry({ provider, query: text, tags });
  const { rows } = await query(
    `INSERT INTO search_query (provider, query, tags) VALUES ($1, $2, $3)
     ON CONFLICT (provider, query) DO NOTHING
     RETURNING id`,
    [entry.provider, entry.query, entry.tags],
  );
  if (rows.length === 0) throw new Error(`Requête existante pour ${entry.provider} : « ${entry.query} »`);
  return { id: Number(rows[0].id), ...entry };
}

// Le fichier est validé en entier avant toute insertion ; les requêtes déjà
// connues sont ignorées et comptées.
export async function importQueries(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(data) ? data : data?.queries;
  if (!Array.isArray(list)) throw new Error('Format inattendu : tableau ou {queries: []} requis');
  const entries = list.map((e, i) => checkEntry(e, ` (entrée ${i + 1})`));
  if (entries.length === 0) return { added: 0, skipped: 0 };
  const { rowCount } = await query(
    `INSERT INTO search_query (provider, query, tags)
     SELECT p, q, coalesce(
              (SELECT array_agg(x) FROM jsonb_array_elements_text(t) AS x), '{}')
       FROM unnest($1::text[], $2::text[], $3::jsonb[]) AS e(p, q, t)
     ON CONFLICT (provider, query) DO NOTHING`,
    [entries.map((e) => e.provider), entries.map((e) => e.query), entries.map((e) => JSON.stringify(e.tags))],
  );
  return { added: rowCount, skipped: entries.length - rowCount };
}

// Rendement agrégé depuis search_query_run : seuls les passages réussis comptent.
async function loadQueries({ status, provider } = {}) {
  const { rows } = await query(
    `SELECT sq.id, sq.provider, sq.query, sq.tags, sq.status, sq.next_page, sq.dry_runs,
            sq.last_run_at, sq.exhausted_at,
            count(r.id) FILTER (WHERE r.error IS NULL)::int AS runs,
            coalesce(sum(r.new_domains), 0)::int AS new_domains
       FROM search_query sq
       LEFT JOIN search_query_run r ON r.search_query_id = sq.id
      WHERE ($1::text IS NULL OR sq.status = $1) AND ($2::text IS NULL OR sq.provider = $2)
      GROUP BY sq.id
      ORDER BY sq.id`,
    [status ?? null, provider ?? null],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    provider: r.provider,
    query: r.query,
    tags: r.tags,
    status: r.status,
    nextPage: r.next_page,
    dryRuns: r.dry_runs,
    lastRunAt: r.last_run_at,
    exhaustedAt: r.exhausted_at,
    runs: r.runs,
    newDomains: r.new_domains,
  }));
}

export async function listQueries({ status } = {}) {
  if (status !== undefined && !QUERY_STATUSES.includes(status)) {
    throw new Error(`--status invalide : "${status}" (attendu : ${QUERY_STATUSES.join(', ')})`);
  }
  return (await loadQueries({ status })).map((q) => ({ ...q, priority: priority(q) }));
}

// Une requête épuisée et reposée repart de la page 0.
async function wakeRested({ provider, now, restDays }) {
  const rested = (await loadQueries({ status: 'exhausted', provider }))
    .filter((q) => isRested(q.exhaustedAt, now, restDays))
    .map((q) => q.id);
  if (rested.length === 0) return 0;
  await query(
    `UPDATE search_query SET status = 'active', next_page = 0, dry_runs = 0, exhausted_at = NULL
      WHERE id = ANY($1)`,
    [rested],
  );
  return rested.length;
}

// Pour le provider file, la requête est le chemin de l'export ; `{page}` y
// désigne la page demandée.
function inputFor(q, page) {
  return q.provider === 'file' ? q.query.replaceAll('{page}', String(page)) : undefined;
}

// Au plus `budget` appels aux providers : un par requête choisie. Une erreur de
// provider est notée sur la requête (la page n'avance pas) sans arrêter le run.
export async function explore({
  budget,
  provider,
  limit = 20,
  restDays = config.exploreRestDays,
  dryRunsLimit = config.exploreDryRuns,
  delayMs = 1000,
  sleep = sleepMs,
  now = () => new Date(),
}) {
  if (!Number.isInteger(budget) || budget <= 0) throw new Error(`--budget doit être un entier > 0 (reçu : ${budget})`);
  if (provider !== undefined) assertProvider(provider);

  return withRun('explore', { budget, provider: provider ?? null }, async (runId) => {
    const woken = await wakeRested({ provider, now: now(), restDays });
    const chosen = selectQueries(await loadQueries({ status: 'active', provider }), budget);
    const queries = [];
    let braveCalled = false;

    for (const q of chosen) {
      const page = q.nextPage;
      if (q.provider === 'brave' && braveCalled) await sleep(delayMs);
      if (q.provider === 'brave') braveCalled = true;
      try {
        const res = await ingest({ provider: q.provider, searchQuery: q.query, input: inputFor(q, page), limit, page });
        const state = nextState({ provider: q.provider, page, newUrls: res.inserted, dryRuns: q.dryRuns, dryRunsLimit });
        await query(
          `INSERT INTO search_query_run (search_query_id, page, results, new_urls, new_domains, run_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [q.id, page, res.total, res.inserted, res.newDomains, runId],
        );
        await query(
          `UPDATE search_query
              SET next_page = $2, runs = runs + 1, dry_runs = $3, last_run_at = now(),
                  status = CASE WHEN $4 THEN 'exhausted' ELSE status END,
                  exhausted_at = CASE WHEN $4 THEN now() ELSE exhausted_at END
            WHERE id = $1`,
          [q.id, state.exhausted ? 0 : state.nextPage, state.dryRuns, state.exhausted],
        );
        queries.push({
          id: q.id, provider: q.provider, query: q.query, page,
          results: res.total, newUrls: res.inserted, newDomains: res.newDomains,
          exhausted: state.exhausted, error: null,
        });
      } catch (err) {
        const error = String(err.message ?? err);
        await query(
          `INSERT INTO search_query_run (search_query_id, page, error, run_id) VALUES ($1, $2, $3, $4)`,
          [q.id, page, error, runId],
        );
        await query('UPDATE search_query SET last_run_at = now() WHERE id = $1', [q.id]);
        queries.push({
          id: q.id, provider: q.provider, query: q.query, page,
          results: 0, newUrls: 0, newDomains: 0, exhausted: false, error,
        });
      }
    }

    const sum = (key) => queries.reduce((acc, r) => acc + r[key], 0);
    return {
      woken,
      queries,
      calls: queries.length,
      errors: queries.filter((r) => r.error).length,
      newUrls: sum('newUrls'),
      newDomains: sum('newDomains'),
    };
  });
}
