import { withTransaction } from '../db.js';
import { withRun } from '../run.js';
import { registerDomains } from '../domains/index.js';
import { canonicalizeUrl, domainOf } from '../normalize/normalizer.js';
import * as fileProvider from './providers/file.js';
import * as braveProvider from './providers/brave.js';
import * as searxngProvider from './providers/searxng.js';
import * as europeanaProvider from './providers/europeana.js';
import * as flickrProvider from './providers/flickr.js';
import * as openrouterProvider from './providers/openrouter.js';

// Domaine tel que la normalisation le calculera, sans réseau ; une URL invalide
// ou non http n'a pas de domaine (la normalisation la marquera en erreur).
function offlineDomain(url) {
  try {
    return domainOf(canonicalizeUrl(url));
  } catch {
    return null;
  }
}

export const providers = {
  file: fileProvider,
  brave: braveProvider,
  searxng: searxngProvider,
  europeana: europeanaProvider,
  flickr: flickrProvider,
  openrouter: openrouterProvider,
};

// US-03 : chaque URL candidate est insérée (ou retrouvée) dans url_item, et sa
// découverte tracée dans url_source (provider, requête, rang, date, run).
// `sentQuery` (requête augmentée d'exclusions) part au provider ; seule
// `searchQuery` est tracée. `excludeDomains` part aux providers qui filtrent par
// paramètre (OpenRouter) plutôt que par `-site:`.
// `requestId` rattache les sources à une recherche payante (search_request).
// Un provider peut renvoyer { results, costUsd } : le coût réel de l'appel est
// alors rendu (null sinon).
export async function ingest({ provider = 'file', searchQuery, sentQuery, excludeDomains, input, limit, page = 0, requestId = null }) {
  const impl = providers[provider];
  if (!impl) {
    throw new Error(`Provider inconnu : ${provider} (disponibles : ${Object.keys(providers).join(', ')})`);
  }
  if (!searchQuery) throw new Error('Option --query requise');

  const detail = {
    provider, query: searchQuery, page,
    ...(sentQuery ? { sentQuery } : {}),
    ...(excludeDomains?.length ? { excludeDomains } : {}),
    ...(requestId !== null ? { requestId } : {}),
  };
  return withRun('ingest', detail, async (runId) => {
    let out;
    try {
      out = await impl.search({ query: sentQuery ?? searchQuery, excludeDomains, input, limit, page });
    } catch (err) {
      // Échec du provider lui-même (rien n'a été écrit) : les recherches payées
      // le distinguent d'un échec d'écriture après un appel facturé.
      if (err && typeof err === 'object') err.providerFailed = true;
      throw err;
    }
    const results = Array.isArray(out) ? out : out.results;
    const costUsd = Array.isArray(out) ? null : (out.costUsd ?? null);
    const urls = results.map((r) => r.url);
    let inserted = 0;
    let newDomains = 0;

    // Trois requêtes par lot, quelle que soit sa taille. Une URL répétée dans la
    // SERP n'est insérée qu'une fois (ON CONFLICT) mais garde une source par occurrence.
    await withTransaction(async (client) => {
      if (results.length === 0) return;
      const created = await client.query(
        `INSERT INTO url_item (raw_url, title)
         SELECT * FROM unnest($1::text[], $2::text[])
         ON CONFLICT (raw_url) DO NOTHING
         RETURNING id`,
        [urls, results.map((r) => r.title ?? null)],
      );
      inserted = created.rowCount;
      // Une variante marquée doublon renvoie vers sa survivante : la requête y est
      // tracée, comme le fait la normalisation pour les sources existantes.
      const { rows } = await client.query(
        'SELECT raw_url, coalesce(duplicate_of, id) AS id FROM url_item WHERE raw_url = ANY($1)',
        [urls],
      );
      const idByUrl = new Map(rows.map((r) => [r.raw_url, r.id]));
      await client.query(
        `INSERT INTO url_source (url_item_id, provider, query, serp_rank, run_id, search_request_id)
         SELECT item_id, $3, $4, serp_rank, $5, $6 FROM unnest($1::bigint[], $2::int[]) AS t(item_id, serp_rank)`,
        [urls.map((u) => idByUrl.get(u)), results.map((r) => r.rank ?? null), provider, searchQuery, runId, requestId],
      );
      // Vignettes fournies par le provider : repli de l'aperçu de la page,
      // http(s) seulement, la première connue d'une URL fait foi.
      const thumbs = results
        .map((r) => [idByUrl.get(r.url), typeof r.thumbnail === 'string' && /^https?:\/\//i.test(r.thumbnail) ? r.thumbnail.slice(0, 2000) : null])
        .filter(([id, thumb]) => id && thumb);
      if (thumbs.length) {
        await client.query(
          `INSERT INTO url_media (url_item_id, kind, source_url)
           SELECT DISTINCT ON (id) id, 'provider', thumb FROM unnest($1::bigint[], $2::text[]) AS t(id, thumb)
           ON CONFLICT (url_item_id, kind) DO NOTHING`,
          [thumbs.map(([id]) => id), thumbs.map(([, thumb]) => thumb)],
        );
      }
      // Un domaine n'est nouveau qu'une fois : la première requête le garde.
      newDomains = (await registerDomains(client, urls.map(offlineDomain), searchQuery, runId)).length;
    });
    const existing = results.length - inserted;

    return { inserted, existing, total: results.length, newDomains, ...(costUsd !== null ? { costUsd } : {}) };
  });
}
