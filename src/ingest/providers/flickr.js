import { config } from '../../config.js';
import { fetchJson, requireConfig } from './http.js';

// Provider Flickr (flickr.photos.search), clé gratuite via FLICKR_API_KEY.
// `page` part de 0 ; Flickr compte ses pages à partir de 1.
export function buildUrl(query, key, limit = 20, page = 0) {
  const url = new URL('https://www.flickr.com/services/rest/');
  url.searchParams.set('method', 'flickr.photos.search');
  url.searchParams.set('api_key', key);
  url.searchParams.set('text', query);
  url.searchParams.set('sort', 'relevance');
  url.searchParams.set('per_page', String(Math.min(limit, 100)));
  url.searchParams.set('format', 'json');
  url.searchParams.set('nojsoncallback', '1');
  // url_w : vignette de 400 px servie par Flickr (repli quand la page n'en déclare pas)
  url.searchParams.set('extras', 'url_w');
  if (page > 0) url.searchParams.set('page', String(page + 1));
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
    thumbnail: typeof p.url_w === 'string' ? p.url_w : null,
  }));
}

export async function search({ query, limit, page }, { fetchImpl, apiKey = config.flickrApiKey } = {}) {
  const key = requireConfig('flickr', apiKey, 'FLICKR_API_KEY');
  return mapResponse(await fetchJson('Flickr', buildUrl(query, key, limit, page), { fetchImpl }));
}
