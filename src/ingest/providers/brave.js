import { config } from '../../config.js';
import { fetchJson, requireConfig } from './http.js';

// Provider Brave Search API (https://api.search.brave.com), clé via BRAVE_API_KEY.
// `page` (0 à 9) devient `offset`, compté en pages de `count` résultats.
export function buildUrl(query, limit = 20, page = 0) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(limit, 20)));
  if (page > 0) url.searchParams.set('offset', String(page));
  return url;
}

export function mapResponse(data) {
  return (data?.web?.results ?? []).map((r, i) => ({
    url: r.url,
    rank: i + 1,
    title: r.title ?? null,
    thumbnail: r.thumbnail?.src ?? null,
  }));
}

export async function search({ query, limit, page }, { fetchImpl, apiKey = config.braveApiKey } = {}) {
  const key = requireConfig('brave', apiKey, 'BRAVE_API_KEY');
  const data = await fetchJson('Brave Search', buildUrl(query, limit, page), {
    headers: { 'X-Subscription-Token': key },
    fetchImpl,
  });
  return mapResponse(data);
}
