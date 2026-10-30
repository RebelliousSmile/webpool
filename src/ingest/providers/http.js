import { config } from '../../config.js';

// Appel JSON commun aux providers : timeout, erreur HTTP lisible, indice pour les
// statuts d'authentification / quota les plus fréquents.
const HINTS = {
  401: 'clé API refusée',
  402: 'crédit épuisé',
  403: 'accès refusé (clé invalide ou quota)',
  429: 'quota dépassé, réessayer plus tard',
};

// `body`, s'il est donné, part en JSON par POST.
export async function fetchJson(name, url, { headers = {}, body, timeoutMs = config.fetchTimeoutMs, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': config.userAgent,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const hint = HINTS[res.status];
    throw new Error(`${name} : HTTP ${res.status}${hint ? ` (${hint})` : ''}`);
  }
  return res.json();
}

export function requireConfig(name, value, envVar) {
  if (!value) throw new Error(`${envVar} manquante pour le provider ${name} (voir .env.example)`);
  return value;
}
