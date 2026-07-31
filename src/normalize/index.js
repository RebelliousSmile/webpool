import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import { startRun, finishRun } from '../run.js';
import { canonicalizeUrl, domainOf, extractCanonicalLink, extractTitle } from './normalizer.js';

// Récupère la page en suivant les redirections ; response.url est l'URL finale.
async function fetchFinal(rawUrl) {
  const res = await fetch(rawUrl, {
    redirect: 'follow',
    headers: { 'User-Agent': config.userAgent, Accept: 'text/html,*/*;q=0.8' },
    signal: AbortSignal.timeout(config.fetchTimeoutMs),
  });
  const contentType = res.headers.get('content-type') ?? '';
  const html = contentType.includes('text/html') ? await res.text() : '';
  return { finalUrl: res.url, httpStatus: res.status, html };
}

async function normalizeOne(item, runId, { offline, fetchImpl }) {
  let finalUrl = item.raw_url;
  let httpStatus = null;
  let title = item.title;
  let declaredCanonical = null;

  if (!offline) {
    const page = await (fetchImpl ?? fetchFinal)(item.raw_url);
    finalUrl = page.finalUrl || item.raw_url;
    httpStatus = page.httpStatus;
    if (page.html) {
      title = extractTitle(page.html) ?? title;
      declaredCanonical = extractCanonicalLink(page.html, finalUrl);
    }
  }

  const canonical = canonicalizeUrl(declaredCanonical ?? finalUrl);
  const domain = domainOf(canonical);

  return withTransaction(async (client) => {
    // Déduplication : domaine + URL canonique (US-04).
    const dup = await client.query(
      `SELECT id FROM url_item
        WHERE domain = $1 AND canonical_url = $2 AND status <> 'duplicate' AND id <> $3`,
      [domain, canonical, item.id],
    );
    if (dup.rows.length > 0) {
      const survivorId = dup.rows[0].id;
      // Les sources de la variante sont rattachées à l'URL survivante : la
      // traçabilité requête → URL est conservée.
      await client.query('UPDATE url_source SET url_item_id = $1 WHERE url_item_id = $2', [
        survivorId,
        item.id,
      ]);
      await client.query(
        `UPDATE url_item
            SET status = 'duplicate', duplicate_of = $2, canonical_url = $3, domain = $4,
                http_status = $5, normalized_at = now(), normalize_run_id = $6
          WHERE id = $1`,
        [item.id, survivorId, canonical, domain, httpStatus, runId],
      );
      return 'duplicate';
    }

    await client.query(
      `UPDATE url_item
          SET status = 'normalized', canonical_url = $2, domain = $3, title = $4,
              http_status = $5, error = NULL, normalized_at = now(), normalize_run_id = $6
        WHERE id = $1`,
      [item.id, canonical, domain, title, httpStatus, runId],
    );
    return 'normalized';
  });
}

// US-04 : traite les url_item en statut 'pending'.
// options.offline : ne suit pas les redirections (canonise l'URL brute telle quelle).
export async function normalizePending({ limit = 100, offline = false, fetchImpl } = {}) {
  const runId = await startRun('normalize', { limit, offline });
  const counts = { normalized: 0, duplicate: 0, error: 0 };
  try {
    const { rows: items } = await query(
      "SELECT id, raw_url, title FROM url_item WHERE status = 'pending' ORDER BY id LIMIT $1",
      [limit],
    );
    for (const item of items) {
      try {
        const outcome = await normalizeOne(item, runId, { offline, fetchImpl });
        counts[outcome] += 1;
      } catch (err) {
        counts.error += 1;
        await query(
          `UPDATE url_item SET status = 'error', error = $2, normalize_run_id = $3 WHERE id = $1`,
          [item.id, String(err.message ?? err).slice(0, 500), runId],
        );
      }
    }
    await finishRun(runId, 'done', counts);
    return { runId, ...counts, total: items.length };
  } catch (err) {
    await finishRun(runId, 'failed', { error: String(err.message ?? err) });
    throw err;
  }
}
