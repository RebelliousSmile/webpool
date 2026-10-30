import { withTransaction } from '../db.js';
import { withRun } from '../run.js';
import { registerDomains } from '../domains/index.js';
import { canonicalizeUrl, domainOf } from '../normalize/normalizer.js';
import * as fileProvider from './providers/file.js';
import * as braveProvider from './providers/brave.js';
import * as searxngProvider from './providers/searxng.js';
import * as europeanaProvider from './providers/europeana.js';
import * as flickrProvider from './providers/flickr.js';

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
};

// US-03 : chaque URL candidate est insérée (ou retrouvée) dans url_item, et sa
// découverte tracée dans url_source (provider, requête, rang, date, run).
export async function ingest({ provider, searchQuery, input, limit }) {
  const impl = providers[provider];
  if (!impl) {
    throw new Error(`Provider inconnu : ${provider} (disponibles : ${Object.keys(providers).join(', ')})`);
  }
  if (!searchQuery) throw new Error('Option --query requise');

  return withRun('ingest', { provider, query: searchQuery }, async (runId) => {
    const results = await impl.search({ query: searchQuery, input, limit });
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
        `INSERT INTO url_source (url_item_id, provider, query, serp_rank, run_id)
         SELECT item_id, $3, $4, serp_rank, $5 FROM unnest($1::bigint[], $2::int[]) AS t(item_id, serp_rank)`,
        [urls.map((u) => idByUrl.get(u)), results.map((r) => r.rank ?? null), provider, searchQuery, runId],
      );
      // Un domaine n'est nouveau qu'une fois : la première requête le garde.
      newDomains = (await registerDomains(client, urls.map(offlineDomain), searchQuery)).length;
    });
    const existing = results.length - inserted;

    return { inserted, existing, total: results.length, newDomains };
  });
}
