import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import { withRun } from '../run.js';
import { registerDomains } from '../domains/index.js';
import { createFetcher, mapLimit, HttpError } from './fetcher.js';
import { canonicalizeUrl, domainOf, extractCanonicalLink, extractMeta, extractTitle } from './normalizer.js';
import { mediaOf } from '../media/kinds.js';

// Une page ne peut revendiquer que l'URL de son propre domaine (hôte exact,
// `www.` retiré) : sinon elle provoquerait la fusion d'URL d'un autre site.
function sameDomainCanonical(declared, finalUrl) {
  if (!declared) return null;
  try {
    return domainOf(canonicalizeUrl(declared)) === domainOf(canonicalizeUrl(finalUrl)) ? declared : null;
  } catch {
    return null; // schéma non http(s) : canonical ignoré
  }
}

// IP publique fixe : un `fetchImpl` injecté (tests) ne doit déclencher aucune résolution DNS.
const fakePublicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

async function normalizeOne(item, runId, page) {
  let finalUrl = item.raw_url;
  let httpStatus = null;
  let title = item.title;
  let declaredCanonical = null;
  let meta = {};
  let contentType = null;

  if (page) {
    // US-07 : une réponse 3xx (sans location), 4xx ou 5xx n'est pas une page exploitable.
    if (page.httpStatus >= 300) throw new HttpError(page.httpStatus);
    finalUrl = page.finalUrl || item.raw_url;
    httpStatus = page.httpStatus;
    contentType = page.contentType ?? null;
    if (page.html) {
      meta = extractMeta(page.html, finalUrl);
      title = extractTitle(page.html) ?? meta.title ?? title;
      declaredCanonical = sameDomainCanonical(extractCanonicalLink(page.html, finalUrl), finalUrl);
    }
  }

  const canonical = canonicalizeUrl(declaredCanonical ?? finalUrl);
  const domain = domainOf(canonical);
  const mediaType = mediaOf(canonical, { contentType, ogType: meta.ogType });
  // Aperçu : l'image déclarée par la page, ou la ressource elle-même si c'en est une.
  const preview = meta.image ?? (page && mediaType === 'image' && /^image\//i.test(contentType ?? '') ? finalUrl : null);

  return withTransaction(async (client) => {
    // Une redirection peut mener à un domaine que l'ingestion n'a pas vu.
    const { rows: first } = await client.query(
      'SELECT query FROM url_source WHERE url_item_id = $1 ORDER BY discovered_at, id LIMIT 1',
      [item.id],
    );
    await registerDomains(client, [domain], first[0]?.query ?? null);

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
      // Les vignettes candidates aussi, sauf celles que la survivante a déjà.
      await client.query(
        `UPDATE url_media m SET url_item_id = $1
          WHERE m.url_item_id = $2
            AND NOT EXISTS (SELECT 1 FROM url_media s WHERE s.url_item_id = $1 AND s.kind = m.kind)`,
        [survivorId, item.id],
      );
      await client.query('DELETE FROM url_media WHERE url_item_id = $1', [item.id]);
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
              http_status = $5, error = NULL, normalized_at = now(), normalize_run_id = $6,
              description = coalesce($7, description), media_type = $8,
              lang = coalesce($9, lang), site_name = coalesce($10, site_name)
        WHERE id = $1`,
      [item.id, canonical, domain, title, httpStatus, runId, meta.description ?? null, mediaType, meta.lang ?? null, meta.siteName ?? null],
    );
    // Une nouvelle source d'aperçu relance le téléchargement ; la même ne change rien.
    if (preview) {
      await client.query(
        `INSERT INTO url_media (url_item_id, kind, source_url) VALUES ($1, 'og', $2)
         ON CONFLICT (url_item_id, kind) DO UPDATE
           SET source_url = EXCLUDED.source_url, status = 'pending', file = NULL, error = NULL
         WHERE url_media.source_url <> EXCLUDED.source_url`,
        [item.id, preview],
      );
    }
    // Favicon : la première source connue d'un domaine fait foi.
    if (meta.icon) {
      await client.query(
        `UPDATE domain_profile SET favicon_source = $2, favicon_status = 'pending'
          WHERE domain = $1 AND favicon_source IS NULL`,
        [domain, meta.icon],
      );
    }
    return 'normalized';
  });
}

// US-04 : traite les url_item en statut 'pending'.
// options.offline : ne suit pas les redirections (canonise l'URL brute telle quelle).
// US-10 : la phase réseau est concurrente (bornée, polie par hôte) ; la phase base
// reste séquentielle pour que la déduplication soit déterministe. Le travail se fait
// par blocs de `chunkSize` : mémoire bornée, et un bloc écrit survit à une panne
// des suivants.
export async function normalizePending({
  limit = 100,
  offline = false,
  concurrency = config.concurrency,
  chunkSize = config.normalizeChunk,
  fetchImpl,
  fetcher = createFetcher(
    fetchImpl ? { fetchImpl, lookup: fakePublicLookup, perHostDelayMs: 0, backoffMs: 0 } : {},
  ),
} = {}) {
  return withRun('normalize', { limit, offline, concurrency }, async (runId) => {
    const counts = { normalized: 0, duplicate: 0, error: 0 };
    const { rows: items } = await query(
      "SELECT id, raw_url, title FROM url_item WHERE status = 'pending' ORDER BY id LIMIT $1",
      [limit],
    );

    for (let start = 0; start < items.length; start += chunkSize) {
      const chunk = items.slice(start, start + chunkSize);
      const pages = offline
        ? chunk.map(() => ({ value: null }))
        : await mapLimit(chunk, concurrency, (item) => fetcher(item.raw_url));

      for (const [i, item] of chunk.entries()) {
        try {
          if (pages[i].error) throw pages[i].error;
          const outcome = await normalizeOne(item, runId, pages[i].value);
          counts[outcome] += 1;
        } catch (err) {
          counts.error += 1;
          await query(
            `UPDATE url_item SET status = 'error', error = $2, http_status = $3, normalize_run_id = $4 WHERE id = $1`,
            [item.id, String(err.message ?? err).slice(0, 500), err.httpStatus ?? null, runId],
          );
        }
      }
    }
    return { ...counts, total: items.length };
  });
}
