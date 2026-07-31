import { config } from '../../config.js';

// Provider Brave Search API (https://api.search.brave.com), clé via BRAVE_API_KEY.
export async function search({ query, limit = 20 }) {
  if (!config.braveApiKey) {
    throw new Error('BRAVE_API_KEY manquante (voir .env.example)');
  }
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(limit, 20)));

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': config.braveApiKey,
    },
    signal: AbortSignal.timeout(config.fetchTimeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Brave Search : HTTP ${res.status}`);
  }
  const data = await res.json();
  const results = data?.web?.results ?? [];
  return results.map((r, i) => ({ url: r.url, rank: i + 1, title: r.title ?? null }));
}
