import { config } from '../../config.js';
import { fetchJson, requireConfig } from './http.js';

// Provider OpenRouter, plugin `web` (https://openrouter.ai), clé via OPENROUTER_API_KEY.
// Les résultats viennent des annotations `url_citation` : le plugin y rend tous
// les résultats de recherche, la réponse du modèle n'est jamais lue (5 tokens au plus).
// Pas de pagination : `max_results` plafonne à 20 et `page` est ignorée.
export const ENGINES = ['perplexity', 'exa', 'parallel'];

export function buildBody(query, { limit = 20, engine = 'perplexity', model, excludeDomains = [] } = {}) {
  if (!ENGINES.includes(engine)) {
    throw new Error(`Moteur OpenRouter inconnu : ${engine} (disponibles : ${ENGINES.join(', ')})`);
  }
  const plugin = { id: 'web', engine, max_results: Math.min(limit, 20) };
  if (excludeDomains.length) plugin.exclude_domains = excludeDomains;
  return {
    model,
    plugins: [plugin],
    messages: [{ role: 'user', content: `Reply with "ok". Search: ${query}` }],
    max_tokens: 5,
    // coût réel de l'appel dans usage.cost (USD), pour vérifier le prix des recherches
    usage: { include: true },
  };
}

// Une URL citée deux fois n'est gardée qu'à sa première place.
export function mapResponse(data) {
  const seen = new Set();
  return (data?.choices?.[0]?.message?.annotations ?? [])
    .filter((a) => a?.type === 'url_citation' && typeof a.url_citation?.url === 'string')
    .map((a) => a.url_citation)
    .filter((c) => !seen.has(c.url) && seen.add(c.url))
    .map((c, i) => ({ url: c.url, rank: i + 1, title: c.title || null }));
}

export async function search(
  { query, limit, excludeDomains },
  { fetchImpl, apiKey = config.openrouterApiKey, engine = config.openrouterEngine, model = config.openrouterModel } = {},
) {
  const key = requireConfig('openrouter', apiKey, 'OPENROUTER_API_KEY');
  const data = await fetchJson('OpenRouter', 'https://openrouter.ai/api/v1/chat/completions', {
    headers: { Authorization: `Bearer ${key}` },
    body: buildBody(query, { limit, engine, model, excludeDomains }),
    // recherche puis génération : 3 à 11 s mesurées, au-delà du timeout des autres providers
    timeoutMs: config.openrouterTimeoutMs,
    fetchImpl,
  });
  const cost = data?.usage?.cost;
  return { results: mapResponse(data), costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null };
}
