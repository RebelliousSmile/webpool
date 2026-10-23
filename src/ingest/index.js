import { query, withTransaction } from '../db.js';
import { startRun, finishRun } from '../run.js';
import * as fileProvider from './providers/file.js';
import * as braveProvider from './providers/brave.js';
import * as searxngProvider from './providers/searxng.js';
import * as europeanaProvider from './providers/europeana.js';
import * as flickrProvider from './providers/flickr.js';

export const providers = {
  file: fileProvider,
  brave: braveProvider,
  searxng: searxngProvider,
  europeana: europeanaProvider,
  flickr: flickrProvider,
};

// US-03 : chaque URL candidate est insérée (ou retrouvée) dans url_item, et sa
// découverte tracée dans url_source (provider, requête, rang, date, run).
export async function ingest({ provider, searchQuery, input, limit }) {
  const impl = providers[provider];
  if (!impl) {
    throw new Error(`Provider inconnu : ${provider} (disponibles : ${Object.keys(providers).join(', ')})`);
  }
  if (!searchQuery) throw new Error('Option --query requise');

  const runId = await startRun('ingest', { provider, query: searchQuery });
  try {
    const results = await impl.search({ query: searchQuery, input, limit });
    let inserted = 0;
    let existing = 0;

    for (const { url, rank, title } of results) {
      await withTransaction(async (client) => {
        const found = await client.query(
          `INSERT INTO url_item (raw_url, title) VALUES ($1, $2)
           ON CONFLICT (raw_url) DO NOTHING
           RETURNING id`,
          [url, title],
        );
        let urlItemId;
        if (found.rows.length > 0) {
          urlItemId = found.rows[0].id;
          inserted += 1;
        } else {
          const { rows } = await client.query('SELECT id FROM url_item WHERE raw_url = $1', [url]);
          urlItemId = rows[0].id;
          existing += 1;
        }
        await client.query(
          `INSERT INTO url_source (url_item_id, provider, query, serp_rank, run_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [urlItemId, provider, searchQuery, rank, runId],
        );
      });
    }

    await finishRun(runId, 'done', { inserted, existing, total: results.length });
    return { runId, inserted, existing, total: results.length };
  } catch (err) {
    await finishRun(runId, 'failed', { error: String(err.message ?? err) });
    throw err;
  }
}

export async function pendingCount() {
  const { rows } = await query("SELECT count(*)::int AS n FROM url_item WHERE status = 'pending'");
  return rows[0].n;
}
