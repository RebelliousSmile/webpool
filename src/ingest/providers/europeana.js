import { config } from '../../config.js';
import { fetchJson, requireConfig } from './http.js';

// Provider Europeana Search API (patrimoine culturel), clé gratuite via EUROPEANA_API_KEY.
export function buildUrl(query, key, limit = 20) {
  const url = new URL('https://api.europeana.eu/record/v2/search.json');
  url.searchParams.set('wskey', key);
  url.searchParams.set('query', query);
  url.searchParams.set('rows', String(Math.min(limit, 100)));
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
    }));
}

export async function search({ query, limit }, { fetchImpl, apiKey = config.europeanaApiKey } = {}) {
  const key = requireConfig('europeana', apiKey, 'EUROPEANA_API_KEY');
  return mapResponse(await fetchJson('Europeana', buildUrl(query, key, limit), { fetchImpl }));
}
