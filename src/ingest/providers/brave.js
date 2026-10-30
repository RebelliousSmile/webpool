import { config } from '../../config.js';
import { fetchJson, requireConfig } from './http.js';

// Provider Brave Search API (https://api.search.brave.com), clé via BRAVE_API_KEY.
export function buildUrl(query, limit = 20) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(limit, 20)));
  return url;
}

export function mapResponse(data) {
  return (data?.web?.results ?? []).map((r, i) => ({ url: r.url, rank: i + 1, title: r.title ?? null }));
}

export async function search({ query, limit }, { fetchImpl, apiKey = config.braveApiKey } = {}) {
  const key = requireConfig('brave', apiKey, 'BRAVE_API_KEY');
  const data = await fetchJson('Brave Search', buildUrl(query, limit), {
    headers: { 'X-Subscription-Token': key },
    fetchImpl,
  });
  return mapResponse(data);
}
