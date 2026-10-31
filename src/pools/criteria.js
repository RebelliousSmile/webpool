// US-06 — traduit une définition de pool (JSON lisible et réexécutable) en
// requête SQL paramétrée. Fonction pure : testable sans base.
//
// Définition acceptée :
// {
//   "theme": "ia-generative",            // thème principal exigé
//   "subthemes": ["lora-training"],      // au moins un de ces sous-thèmes
//   "facets": { "content-type": "tutoriel" },
//   "min_relevance": 0.3,
//   "min_quality": 0.5,
//   "domains_exclude": ["pinterest.com"],
//   "domains_include": [],               // si non vide : liste blanche
//   "order": "quality",                  // quality | relevance | recent | composite | rarity
//   "limit": 50,
//   "include_requests": true             // + URLs des recherches de ses communautés, hors critères de sujet
// }

// Rareté : 1 / sqrt(URLs vivantes du domaine) ; une URL d'un domaine unique vaut 1.
const RARITY = '1 / sqrt(coalesce(dc.urls, 1))';

const ORDERS = {
  quality: 'ui.quality_score DESC NULLS LAST',
  relevance: 'ui.relevance_score DESC NULLS LAST',
  recent: 'ui.first_seen_at DESC',
  composite: '(coalesce(ui.relevance_score, 0) + coalesce(ui.quality_score, 0)) / 2 DESC',
  rarity: `${RARITY} DESC, ui.quality_score DESC NULLS LAST`,
};

const SCORE_EXPR = {
  quality: 'coalesce(ui.quality_score, 0)',
  relevance: 'coalesce(ui.relevance_score, 0)',
  // décroît avec l'âge en jours, sans changer l'ordre first_seen_at DESC
  recent: '1 / (1 + extract(epoch FROM now() - ui.first_seen_at) / 86400)',
  composite: '(coalesce(ui.relevance_score, 0) + coalesce(ui.quality_score, 0)) / 2',
  rarity: RARITY,
};

// Jointure ajoutée pour les seuls ordres qui en ont besoin.
const JOINS = {
  rarity:
    `  LEFT JOIN (SELECT domain, count(*) AS urls FROM url_item\n` +
    `              WHERE status <> 'duplicate' AND domain IS NOT NULL GROUP BY domain) dc ON dc.domain = ui.domain\n`,
};

const KNOWN_KEYS = new Set([
  'theme', 'subthemes', 'facets', 'min_relevance', 'min_quality',
  'domains_include', 'domains_exclude', 'order', 'limit', 'include_requests',
]);

const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isStringRecord = (v) =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');
const isUnitNumber = (v) => typeof v === 'number' && v >= 0 && v <= 1;

const CHECKS = {
  theme: [(v) => typeof v === 'string', 'une chaîne'],
  subthemes: [isStringArray, 'un tableau de chaînes'],
  domains_include: [isStringArray, 'un tableau de chaînes'],
  domains_exclude: [isStringArray, 'un tableau de chaînes'],
  facets: [isStringRecord, 'un objet de chaînes'],
  min_relevance: [isUnitNumber, 'un nombre entre 0 et 1'],
  min_quality: [isUnitNumber, 'un nombre entre 0 et 1'],
  order: [(v) => typeof v === 'string', 'une chaîne'],
  limit: [Number.isInteger, 'un entier'],
  include_requests: [(v) => typeof v === 'boolean', 'un booléen'],
};

// Une définition vient d'un fichier JSON : chaque critère est typé avant de
// partir en paramètre SQL, avec un message qui le nomme.
function validateDefinition(definition) {
  if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
    throw new Error('Définition de pool invalide : objet JSON attendu');
  }
  for (const [key, value] of Object.entries(definition)) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`Critère inconnu dans la définition : ${key}`);
    const [check, expected] = CHECKS[key];
    if (value != null && !check(value)) {
      throw new Error(`Critère ${key} invalide : ${expected} attendu (reçu : ${JSON.stringify(value)})`);
    }
  }
}

// `poolId` sert au critère include_requests : une URL trouvée par une recherche
// payée par une communauté propriétaire du pool, et qui le vise, y entre dès
// qu'elle est classée, sans remplir les
// critères de sujet (theme, subthemes, facets, domains_include) ; les seuils
// min_relevance et min_quality et domains_exclude s'appliquent toujours.
export function buildPoolQuery(definition, { poolId = null } = {}) {
  validateDefinition(definition);
  const order = definition.order ?? 'composite';
  if (!Object.hasOwn(ORDERS, order)) {
    throw new Error(`Ordre inconnu : ${order} (attendu : ${Object.keys(ORDERS).join(', ')})`);
  }

  const values = [];
  const where = [];
  const add = (value) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (definition.theme) {
    where.push(
      `EXISTS (SELECT 1 FROM url_theme ut JOIN theme t ON t.id = ut.theme_id
               WHERE ut.url_item_id = ui.id AND ut.is_primary AND t.slug = ${add(definition.theme)})`,
    );
  }
  if (definition.subthemes?.length) {
    where.push(
      `EXISTS (SELECT 1 FROM url_theme ut JOIN theme t ON t.id = ut.theme_id
               WHERE ut.url_item_id = ui.id AND t.slug = ANY(${add(definition.subthemes)}))`,
    );
  }
  for (const [facetSlug, value] of Object.entries(definition.facets ?? {})) {
    where.push(
      `EXISTS (SELECT 1 FROM url_facet_value ufv JOIN facet_definition fd ON fd.id = ufv.facet_id
               WHERE ufv.url_item_id = ui.id AND fd.slug = ${add(facetSlug)} AND ufv.value = ${add(value)})`,
    );
  }
  if (definition.domains_include?.length) {
    where.push(`ui.domain = ANY(${add(definition.domains_include)})`);
  }
  // Seuils de qualité : jamais contournés, même par include_requests.
  const thresholds = [];
  if (definition.min_relevance != null) {
    thresholds.push(`ui.relevance_score >= ${add(definition.min_relevance)}`);
  }
  if (definition.min_quality != null) {
    thresholds.push(`ui.quality_score >= ${add(definition.min_quality)}`);
  }
  const conditions = ["ui.status = 'classified'", ...thresholds];
  // Sans autre critère, le pool prend déjà toutes les URLs classées.
  if (definition.include_requests && poolId !== null && where.length) {
    // Seules comptent les recherches payées par une communauté propriétaire du
    // pool : un client qui paie sur son portefeuille personnel n'y injecte rien.
    const requested =
      `EXISTS (SELECT 1 FROM url_source us JOIN search_request sr ON sr.id = us.search_request_id\n` +
      `               JOIN wallet w ON w.id = sr.wallet_id\n` +
      `               JOIN community_pool cp ON cp.community_id = w.community_id AND cp.pool_id = sr.pool_id\n` +
      `               WHERE us.url_item_id = ui.id AND sr.pool_id = ${add(poolId)})`;
    conditions.push(`((${where.join('\n   AND ')})\n   OR ${requested})`);
  } else {
    conditions.push(...where);
  }
  if (definition.domains_exclude?.length) {
    conditions.push(`NOT (ui.domain = ANY(${add(definition.domains_exclude)}))`);
  }

  const limit = Math.max(1, Math.min(1000, definition.limit ?? 100));
  const text =
    `SELECT ui.id, ui.canonical_url, ui.domain, ${SCORE_EXPR[order]} AS pool_score\n` +
    `  FROM url_item ui\n` +
    (JOINS[order] ?? '') +
    ` WHERE ${conditions.join('\n   AND ')}\n` +
    ` ORDER BY ${ORDERS[order]}, ui.id\n` +
    ` LIMIT ${add(limit)}`;

  return { text, values };
}
