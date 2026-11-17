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
//   "include_requests": true             // + URLs des recherches et listes de ses communautés (ou d'un admin), hors critères de sujet ;
//                                        //   "only" : uniquement celles-là
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
  include_requests: [(v) => typeof v === 'boolean' || v === 'only', 'un booléen ou "only"'],
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
// qu'elle est classée, sans remplir les critères de sujet (theme, subthemes,
// facets, domains_include), après la sélection normale ; les seuils
// min_relevance et min_quality et domains_exclude s'appliquent toujours.
export function buildPoolQuery(definition, { poolId = null } = {}) {
  validateDefinition(definition);
  // "only" ignore les critères de sujet : on les retire avant de construire la
  // requête, pour qu'aucune de leurs valeurs ne reste en paramètre inutilisé.
  if (definition.include_requests === 'only' && poolId !== null) {
    const { theme, subthemes, facets, domains_include: domainsInclude, ...rest } = definition;
    if (theme || subthemes?.length || Object.keys(facets ?? {}).length || domainsInclude?.length) {
      return buildPoolQuery(rest, { poolId });
    }
  }
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
  // Toujours appliqués : classée, hors quarantaine, seuils de qualité, domaines exclus.
  const always = ["ui.status = 'classified'", 'ui.quarantined_at IS NULL', ...thresholds];
  if (definition.domains_exclude?.length) {
    always.push(`NOT (ui.domain = ANY(${add(definition.domains_exclude)}))`);
  }
  const limit = Math.max(1, Math.min(1000, definition.limit ?? 100));
  const limitParam = add(limit);
  const select = (conds, rank) =>
    `SELECT ui.id, ui.canonical_url, ui.domain, ${SCORE_EXPR[order]} AS pool_score,\n` +
    `       row_number() OVER (ORDER BY ${ORDERS[order]}, ui.id) AS ${rank}\n` +
    `  FROM url_item ui\n` +
    (JOINS[order] ?? '') +
    ` WHERE ${conds.join('\n   AND ')}\n` +
    ` ORDER BY ${ORDERS[order]}, ui.id\n` +
    ` LIMIT ${limitParam}`;

  // URLs des soumissions qualifiées qui visent ce pool : payées par une
  // communauté propriétaire du pool, ou faites par un admin. Un client qui paie
  // sur son portefeuille personnel n'y injecte rien. IN (sous-requête) plutôt
  // qu'un OR EXISTS : PostgreSQL en fait une semi-jointure indexée.
  const requestedSql = () =>
    `ui.id IN (SELECT us.url_item_id FROM url_source us\n` +
    `                 JOIN search_request sr ON sr.id = us.search_request_id\n` +
    `                 JOIN wallet w ON w.id = sr.wallet_id\n` +
    `                 JOIN api_client ac ON ac.id = sr.api_client_id\n` +
    `                 LEFT JOIN community_pool cp ON cp.community_id = w.community_id AND cp.pool_id = sr.pool_id\n` +
    `                WHERE sr.pool_id = ${add(poolId)} AND (cp.pool_id IS NOT NULL OR ac.scope = 'admin'))`;
  const simple = (conds) =>
    `SELECT ui.id, ui.canonical_url, ui.domain, ${SCORE_EXPR[order]} AS pool_score\n` +
    `  FROM url_item ui\n` +
    (JOINS[order] ?? '') +
    ` WHERE ${conds.join('\n   AND ')}\n` +
    ` ORDER BY ${ORDERS[order]}, ui.id\n` +
    ` LIMIT ${limitParam}`;

  // "only" : le pool ne contient que les soumissions qui le visent (la
  // sélection d'une communauté ou de l'admin), critères de sujet ignorés.
  if (definition.include_requests === 'only' && poolId !== null) {
    return { text: simple([...always, requestedSql()]), values };
  }
  // Sans critère de sujet, le pool prend déjà toutes les URLs classées.
  if (!(definition.include_requests && poolId !== null && where.length)) {
    return { text: simple([...always, ...where]), values };
  }

  // include_requests : la sélection normale (au plus `limit`), puis, après
  // elle, les URLs des soumissions qualifiées qui n'y sont pas déjà (au plus
  // `limit` de plus) : une soumission ne dispute pas sa place à la sélection.
  const requested = requestedSql();
  const text =
    `WITH base AS (\n${select([...always, ...where], 'rn')}\n),\n` +
    `extra AS (\n${select([...always, requested, 'ui.id NOT IN (SELECT id FROM base)'], 'rn')}\n)\n` +
    `SELECT id, canonical_url, domain, pool_score FROM (\n` +
    `  SELECT *, 1 AS part FROM base UNION ALL SELECT *, 2 AS part FROM extra\n` +
    `) t ORDER BY part, rn`;
  return { text, values };
}
