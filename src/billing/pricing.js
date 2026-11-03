// Prix des recherches — fonctions pures (aucune I/O).
//
// Le giri est l'unité entière du grand livre ; un don ou un achat en € se
// convertit au taux `giriPerEur`. Un appel au provider coûte
// max(1, ⌈coût USD × usdEur × markup × giriPerEur⌉) giri.

// Coût d'un appel en USD. OpenRouter dépend du moteur du plugin web (mesures du
// README, 20 résultats) ; Brave au tarif public (5 $ les 1 000 requêtes) ; les
// autres ne facturent pas de tokens, le prix plancher s'applique.
export const DEFAULT_CALL_COSTS_USD = Object.freeze({
  'openrouter:perplexity': 0.0055,
  'openrouter:exa': 0.0175,
  'openrouter:parallel': 0.016,
  brave: 0.005,
  searxng: 0,
  europeana: 0,
  flickr: 0,
});

// Le provider `file` lit un fichier du serveur dont le chemin est la requête :
// jamais ouvert aux recherches, quelle que soit la configuration.
export const FORBIDDEN_REQUEST_PROVIDERS = Object.freeze(['file']);

// Providers qui ne paginent pas : une recherche n'y achète qu'une page.
export const SINGLE_PAGE_PROVIDERS = Object.freeze(['openrouter']);

export const MAX_QUERY_CHARS = 200;

// "brave=0.005, openrouter:exa=0.02" → { brave: 0.005, 'openrouter:exa': 0.02 }
export function parseCallCosts(raw) {
  const costs = {};
  for (const part of (raw ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^([a-z]+(?::[a-z]+)?)\s*=\s*(\d+(?:\.\d+)?)$/.exec(part);
    if (!m) throw new Error(`WEBPOOL_CALL_COST_USD invalide : "${part}" (attendu : provider=coût, ex. brave=0.005)`);
    costs[m[1]] = Number(m[2]);
  }
  return costs;
}

// Clé de coût : le moteur compte pour OpenRouter.
export const costKey = (provider, engine) => (provider === 'openrouter' ? `openrouter:${engine}` : provider);

export function callCostUsd(provider, { engine, overrides = {} } = {}) {
  const key = costKey(provider, engine);
  for (const k of [key, provider]) {
    if (Object.hasOwn(overrides, k)) return overrides[k];
  }
  return DEFAULT_CALL_COSTS_USD[key] ?? DEFAULT_CALL_COSTS_USD[provider] ?? 0;
}

// Arrondi à 1e-6 avant le plafond : 9.200000000000001 ne doit pas devenir 10 de trop,
// ni 10.000000000002 devenir 11.
export function priceOf(costUsd, { usdEur, markup, giriPerEur }) {
  const raw = Math.round(costUsd * usdEur * markup * giriPerEur * 1e6) / 1e6;
  return Math.max(1, Math.ceil(raw));
}

// Providers ouverts aux recherches, avec prix d'un appel et pages achetables.
export function priceList({ providers, available, engine, overrides, usdEur, markup, giriPerEur, maxPages }) {
  return providers
    .filter((p) => available.includes(p) && !FORBIDDEN_REQUEST_PROVIDERS.includes(p))
    .map((provider) => {
      const costUsd = callCostUsd(provider, { engine, overrides });
      return {
        provider,
        unit_price: priceOf(costUsd, { usdEur, markup, giriPerEur }),
        cost_usd: costUsd,
        max_pages: SINGLE_PAGE_PROVIDERS.includes(provider) ? 1 : maxPages,
      };
    });
}

// "12", "12.5", "12,50" → 1250 centimes ; refuse le reste (pas de flottant).
export function parseEuros(raw) {
  const m = /^\s*(\d{1,7})(?:[.,](\d{1,2}))?\s*$/.exec(String(raw ?? ''));
  if (!m) throw new Error(`Montant en euros invalide : "${raw}" (ex. 10 ou 12,50)`);
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (cents <= 0) throw new Error('Le montant doit être positif');
  return cents;
}

export const giriFromCents = (cents, giriPerEur) => Math.floor((cents * giriPerEur) / 100);

// Valeur en € d'un nombre de giri, pour l'affichage.
export const eurosOf = (giri, giriPerEur) => giri / giriPerEur;

// Valide une demande de recherche ; renvoie { provider, query, pages, unitPrice }.
// `prices` vient de priceList.
export function checkRequest({ provider, query, pages }, prices) {
  const text = typeof query === 'string' ? query.trim().replace(/\s+/g, ' ') : '';
  if (!text) throw new Error('query requis');
  if (text.length > MAX_QUERY_CHARS) throw new Error(`query trop longue : ${MAX_QUERY_CHARS} caractères au plus`);
  const price = prices.find((p) => p.provider === provider);
  if (!price) {
    throw new Error(`provider non ouvert aux recherches : "${provider}" (ouverts : ${prices.map((p) => p.provider).join(', ') || 'aucun'})`);
  }
  const n = pages ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > price.max_pages) {
    throw new Error(`pages doit être un entier entre 1 et ${price.max_pages} pour ${provider}`);
  }
  return { provider, query: text, pages: n, unitPrice: price.unit_price };
}
