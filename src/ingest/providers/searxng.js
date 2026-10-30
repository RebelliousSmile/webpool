import { config } from '../../config.js';
import { fetchJson, requireConfig } from './http.js';

// Provider SearXNG (méta-moteur auto-hébergeable, sans clé). L'instance doit
// autoriser le format JSON (`search.formats: [html, json]` dans settings.yml).
// `page` part de 0 ; SearXNG compte ses pages à partir de 1.
export function buildUrl(baseUrl, query, page = 0) {
  const url = new URL('search', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  if (page > 0) url.searchParams.set('pageno', String(page + 1));
  return url;
}

export function mapResponse(data, limit = 20) {
  return (data?.results ?? [])
    .filter((r) => typeof r.url === 'string')
    .slice(0, limit)
    .map((r, i) => ({ url: r.url, rank: i + 1, title: r.title ?? null }));
}

export async function search({ query, limit, page }, { fetchImpl, baseUrl = config.searxngUrl } = {}) {
  const base = requireConfig('searxng', baseUrl, 'SEARXNG_URL');
  return mapResponse(await fetchJson('SearXNG', buildUrl(base, query, page), { fetchImpl }), limit);
}
