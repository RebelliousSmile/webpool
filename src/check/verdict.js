// Règle du contrôle des liens, sans réseau ni base : verdict d'un test et
// compteur de quarantaine.
//
// - ok : statut final 2xx (redirections suivies par le fetcher) ;
// - dead : échec franc — 404, 410, domaine inexistant, connexion refusée,
//   certificat expiré ou émis pour un autre nom, hôte devenu privé ;
// - unsure : tout le reste (403, 429, 5xx, délai dépassé, EAI_AGAIN, trop de
//   redirections, chaîne de certificats incomplète, erreur inconnue). Historisé,
//   jamais compté : une IP de datacenter reçoit souvent 403/429 de sites sains,
//   une boucle de redirections vient souvent d'un mur de consentement à cookie,
//   et Node ne complète pas une chaîne de certificats que les navigateurs acceptent.
import { HostRefusedError } from '../normalize/hostGuard.js';
import { TooManyRedirectsError } from '../normalize/fetcher.js';

const DEAD_STATUSES = new Set([404, 410]);
const DEAD_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']);

// L'erreur puis sa chaîne `cause` : une erreur DNS de assertPublicHost arrive
// telle quelle, une erreur de connexion sous le « fetch failed » d'undici.
function* chain(err) {
  const seen = new Set();
  for (let e = err; e && typeof e === 'object' && !seen.has(e); e = e.cause) {
    seen.add(e);
    yield e;
  }
}

// Étiquette stockée dans url_check.error. HostRefusedError et
// TooManyRedirectsError ne posent pas `name` : instanceof d'abord.
export function errorLabel(err) {
  const all = [...chain(err)];
  if (all.some((e) => e instanceof HostRefusedError)) return 'HOST_REFUSED';
  if (all.some((e) => e instanceof TooManyRedirectsError)) return 'TOO_MANY_REDIRECTS';
  const coded = all.find((e) => typeof e.code === 'string' && e.code);
  if (coded) return coded.code;
  const named = all.find((e) => e.name && e.name !== 'Error' && e.name !== 'TypeError');
  if (named) return named.name;
  return 'UNKNOWN';
}

// { httpStatus } d'une réponse, ou { error } d'un fetch en échec.
export function verdictOf({ httpStatus = null, error = null } = {}) {
  if (error) {
    const all = [...chain(error)];
    const label = errorLabel(error);
    const dead =
      all.some((e) => e instanceof HostRefusedError) ||
      all.some((e) => !(e instanceof TooManyRedirectsError) && DEAD_CODES.has(e.code));
    return { verdict: dead ? 'dead' : 'unsure', label };
  }
  if (httpStatus >= 200 && httpStatus < 300) return { verdict: 'ok', label: null };
  if (DEAD_STATUSES.has(httpStatus)) return { verdict: 'dead', label: null };
  return { verdict: 'unsure', label: null };
}

// État suivant d'un lien après un test. L'espacement entre deux tests vient de
// la sélection (jamais retesté avant checkIntervalHours) : chaque dead compte.
export function nextState({ streak = 0, quarantinedAt = null, verdict, now = new Date(), threshold = 3 }) {
  if (verdict === 'ok') return { streak: 0, quarantinedAt: null };
  if (verdict !== 'dead') return { streak, quarantinedAt };
  const next = streak + 1;
  return { streak: next, quarantinedAt: quarantinedAt ?? (next >= threshold ? now : null) };
}
