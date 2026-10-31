// Erreurs et paramètres de requête de l'API — fonctions pures (testables sans base).

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message) => new ApiError(400, 'bad_request', message);
export const notFound = (message = 'Ressource introuvable') => new ApiError(404, 'not_found', message);

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

function intParam(params, name, { fallback, min, max }) {
  const raw = params.get(name);
  if (raw === null || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw badRequest(`${name} doit être un entier (reçu : "${raw}")`);
  const n = Number(raw);
  if (n < min || n > max) throw badRequest(`${name} doit être compris entre ${min} et ${max} (reçu : ${n})`);
  return n;
}

export function pageParams(params) {
  return {
    limit: intParam(params, 'limit', { fallback: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT }),
    offset: intParam(params, 'offset', { fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER }),
  };
}

export function enumParam(params, name, allowed) {
  const raw = params.get(name);
  if (raw === null || raw === '') return undefined;
  if (!allowed.includes(raw)) throw badRequest(`${name} invalide : "${raw}" (attendu : ${allowed.join(', ')})`);
  return raw;
}

export function boolParam(params, name) {
  const raw = params.get(name);
  if (raw === null || raw === '') return undefined;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw badRequest(`${name} doit valoir true ou false (reçu : "${raw}")`);
}

export function idParam(raw) {
  if (!/^\d{1,15}$/.test(raw)) throw notFound();
  return Number(raw);
}

// `facet=slug:valeur`, répétable : toutes les facettes demandées sont exigées.
export function facetParams(params) {
  return params.getAll('facet').map((raw) => {
    const sep = raw.indexOf(':');
    if (sep <= 0 || sep === raw.length - 1) throw badRequest(`facet attendu sous la forme slug:valeur (reçu : "${raw}")`);
    return { slug: raw.slice(0, sep), value: raw.slice(sep + 1) };
  });
}

// Motif ILIKE littéral : % et _ saisis par l'utilisateur ne sont pas des jokers.
export const likePattern = (text) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// Les NUMERIC et BIGINT arrivent de pg sous forme de chaînes.
export const num = (v) => (v === null || v === undefined ? null : Number(v));

// Réponse de liste paginée.
export const paged = (items, total, { limit, offset }) => ({ items, total, limit, offset });
