import { config } from '../../config.js';
import { fetchJson, requireConfig } from './http.js';

// Provider Europeana Search API (patrimoine culturel), clé gratuite via EUROPEANA_API_KEY.
// `page` part de 0 ; Europeana pagine par position du premier résultat (1-based).
export function buildUrl(query, key, limit = 20, page = 0) {
  const url = new URL('https://api.europeana.eu/record/v2/search.json');
  const rows = Math.min(limit, 100);
  url.searchParams.set('wskey', key);
  url.searchParams.set('query', query);
  url.searchParams.set('rows', String(rows));
  if (page > 0) url.searchParams.set('start', String(page * rows + 1));
  return url;
}

// `id` vaut "/<collection>/<record>" ; `title` est un tableau multilingue.
export function mapResponse(data) {
  return (data?.items ?? [])
    .filter((item) => typeof item.id === 'string')
    .map((item, i) => ({
      url: `https://www.europeana.eu/item${item.id}`,
      rank: i + 1,
      title: Array.isArray(item.title) ? (item.title[0] ?? null) : (item.title ?? null),
      thumbnail: (Array.isArray(item.edmPreview) ? item.edmPreview[0] : item.edmPreview) ?? null,
    }));
}

export async function search({ query, limit, page }, { fetchImpl, apiKey = config.europeanaApiKey } = {}) {
  const key = requireConfig('europeana', apiKey, 'EUROPEANA_API_KEY');
  return mapResponse(await fetchJson('Europeana', buildUrl(query, key, limit, page), { fetchImpl }));
}
