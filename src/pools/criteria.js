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
//   "order": "quality",                  // quality | relevance | recent | composite
//   "limit": 50
// }

const ORDERS = {
  quality: 'ui.quality_score DESC NULLS LAST',
  relevance: 'ui.relevance_score DESC NULLS LAST',
  recent: 'ui.first_seen_at DESC',
  composite: '(coalesce(ui.relevance_score, 0) + coalesce(ui.quality_score, 0)) / 2 DESC',
};

const SCORE_EXPR = {
  quality: 'coalesce(ui.quality_score, 0)',
  relevance: 'coalesce(ui.relevance_score, 0)',
  recent: '0',
  composite: '(coalesce(ui.relevance_score, 0) + coalesce(ui.quality_score, 0)) / 2',
};

const KNOWN_KEYS = new Set([
  'theme', 'subthemes', 'facets', 'min_relevance', 'min_quality',
  'domains_include', 'domains_exclude', 'order', 'limit',
]);

export function buildPoolQuery(definition) {
  for (const key of Object.keys(definition)) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`Critère inconnu dans la définition : ${key}`);
  }
  const order = definition.order ?? 'composite';
  if (!ORDERS[order]) {
    throw new Error(`Ordre inconnu : ${order} (attendu : ${Object.keys(ORDERS).join(', ')})`);
  }

  const values = [];
  const where = ["ui.status = 'classified'"];
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
  if (definition.min_relevance != null) {
    where.push(`ui.relevance_score >= ${add(definition.min_relevance)}`);
  }
  if (definition.min_quality != null) {
    where.push(`ui.quality_score >= ${add(definition.min_quality)}`);
  }
  if (definition.domains_include?.length) {
    where.push(`ui.domain = ANY(${add(definition.domains_include)})`);
  }
  if (definition.domains_exclude?.length) {
    where.push(`NOT (ui.domain = ANY(${add(definition.domains_exclude)}))`);
  }

  const limit = Math.max(1, Math.min(1000, definition.limit ?? 100));
  const text =
    `SELECT ui.id, ui.canonical_url, ui.domain, ${SCORE_EXPR[order]} AS pool_score\n` +
    `  FROM url_item ui\n` +
    ` WHERE ${where.join('\n   AND ')}\n` +
    ` ORDER BY ${ORDERS[order]}, ui.id\n` +
    ` LIMIT ${add(limit)}`;

  return { text, values };
}
