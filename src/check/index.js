import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import { withRun } from '../run.js';
import { createFetcher, mapLimit } from '../normalize/fetcher.js';
import { nextState, verdictOf } from './verdict.js';

// `webpool check` : teste le statut HTTP final des liens vivants les moins
// récemment testés, historise chaque test (url_check) et tient le compteur de
// quarantaine (url_item.dead_streak, quarantined_at). Un lien testé depuis
// moins de checkIntervalHours n'est pas resélectionné : deux tests d'un même
// lien sont toujours espacés d'au moins cet intervalle.

// IP publique fixe : un `fetchImpl` injecté (tests) ne doit déclencher aucune résolution DNS.
const fakePublicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

// Seul le statut compte : le corps d'une réponse 2xx est abandonné sans lecture.
async function skipBody(res) {
  await res.body?.cancel?.().catch(() => {});
  return {};
}

export function createCheckFetcher({ fetchImpl, ...rest } = {}) {
  return createFetcher({
    ...(fetchImpl ? { fetchImpl, lookup: fakePublicLookup, perHostDelayMs: 0 } : {}),
    ...rest,
    // Pas de rejeu : une réponse transitoire est `unsure`, retestée au passage suivant.
    retries: 0,
    read: skipBody,
  });
}

export async function checkLinks({
  limit = config.checkLimit,
  intervalHours = config.checkIntervalHours,
  threshold = config.checkThreshold,
  retentionDays = config.checkRetentionDays,
  concurrency = config.concurrency,
  now = () => new Date(),
  fetchImpl,
  fetcher = createCheckFetcher({ fetchImpl }),
} = {}) {
  return withRun('check', { limit }, async (runId) => {
    const { rows: links } = await query(
      `SELECT id, coalesce(canonical_url, raw_url) AS url, dead_streak, quarantined_at
         FROM url_item
        WHERE status IN ('normalized', 'classified')
          AND (checked_at IS NULL OR checked_at <= $2::timestamptz - make_interval(hours => $3))
        ORDER BY checked_at NULLS FIRST, id
        LIMIT $1`,
      [limit, now(), intervalHours],
    );

    const counts = { checked: 0, ok: 0, dead: 0, unsure: 0, quarantined: 0, released: 0 };
    const results = await mapLimit(links, concurrency, (l) => fetcher(l.url));
    for (const [i, link] of links.entries()) {
      const { value: page, error } = results[i];
      const { verdict, label } = verdictOf(error ? { error } : { httpStatus: page.httpStatus });
      const at = now();
      const state = nextState({ streak: link.dead_streak, quarantinedAt: link.quarantined_at, verdict, now: at, threshold });
      counts.checked += 1;
      counts[verdict] += 1;
      if (!link.quarantined_at && state.quarantinedAt) counts.quarantined += 1;
      if (link.quarantined_at && !state.quarantinedAt) counts.released += 1;

      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO url_check (url_item_id, checked_at, http_status, verdict, error, final_url, run_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [link.id, at, page?.httpStatus ?? null, verdict, label, page?.finalUrl ?? null, runId],
        );
        await client.query(
          'UPDATE url_item SET checked_at = $2, dead_streak = $3, quarantined_at = $4 WHERE id = $1',
          [link.id, at, state.streak, state.quarantinedAt],
        );
      });
    }

    const { rowCount: purged } = await query(
      `DELETE FROM url_check WHERE checked_at < $1::timestamptz - make_interval(days => $2)`,
      [now(), retentionDays],
    );
    return { ...counts, purged };
  });
}
