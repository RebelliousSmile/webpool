import { config } from '../../config.js';
import { fetchJson, requireConfig } from './http.js';

// Provider Flickr (flickr.photos.search), clé gratuite via FLICKR_API_KEY.
export function buildUrl(query, key, limit = 20) {
  const url = new URL('https://www.flickr.com/services/rest/');
  url.searchParams.set('method', 'flickr.photos.search');
  url.searchParams.set('api_key', key);
  url.searchParams.set('text', query);
  url.searchParams.set('sort', 'relevance');
  url.searchParams.set('per_page', String(Math.min(limit, 100)));
  url.searchParams.set('format', 'json');
  url.searchParams.set('nojsoncallback', '1');
  return url;
}

// Flickr répond HTTP 200 avec {stat:"fail", code, message} en cas d'erreur d'API.
export function mapResponse(data) {
  if (data?.stat === 'fail') {
    throw new Error(`Flickr : ${data.message ?? 'erreur'} (code ${data.code})`);
  }
  return (data?.photos?.photo ?? []).map((p, i) => ({
    url: `https://www.flickr.com/photos/${p.owner}/${p.id}`,
    rank: i + 1,
    title: p.title?.trim() ? p.title : null,
  }));
}

export async function search({ query, limit }, { fetchImpl } = {}) {
  const key = requireConfig('flickr', config.flickrApiKey, 'FLICKR_API_KEY');
  return mapResponse(await fetchJson('Flickr', buildUrl(query, key, limit), { fetchImpl }));
}
