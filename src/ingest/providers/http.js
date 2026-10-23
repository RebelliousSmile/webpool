import { config } from '../../config.js';

// Appel JSON commun aux providers : timeout, erreur HTTP lisible, indice pour les
// statuts d'authentification / quota les plus fréquents.
const HINTS = {
  401: 'clé API refusée',
  403: 'accès refusé (clé invalide ou quota)',
  429: 'quota dépassé, réessayer plus tard',
};

export async function fetchJson(name, url, { headers = {}, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'User-Agent': config.userAgent, ...headers },
    signal: AbortSignal.timeout(config.fetchTimeoutMs),
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
