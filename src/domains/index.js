import { query, withTransaction } from '../db.js';

// Registre des domaines : la qualification d'usage commercial se fait une fois
// par domaine et l'emporte sur les motifs de la taxonomie.
export const USAGE_FACET = 'usage-commercial';
export const USAGE_VALUES = ['libre', 'sous-conditions', 'payant', 'non-commercial'];

// Valide avant toute connexion à la base.
export function assertUsage(value) {
  if (!USAGE_VALUES.includes(value)) {
    throw new Error(`--usage invalide : "${value}" (attendu : ${USAGE_VALUES.join(', ')})`);
  }
  return value;
}

// Même forme que domainOf(canonicalizeUrl(…)) : minuscules, sans `www.`.
export function normalizeDomain(raw) {
  return String(raw ?? '').trim().toLowerCase().replace(/^www\./, '');
}

// Insère les domaines inconnus ; renvoie ceux réellement ajoutés (les nouveaux).
export async function registerDomains(client, domains, firstQuery = null) {
  const unique = [...new Set(domains.filter(Boolean))];
  if (unique.length === 0) return [];
  const { rows } = await client.query(
    `INSERT INTO domain_profile (domain, first_query)
     SELECT d, $2 FROM unnest($1::text[]) AS d
     ON CONFLICT (domain) DO NOTHING
     RETURNING domain`,
    [unique, firstQuery],
  );
  return rows.map((r) => r.domain);
}

// Qualifications connues pour une liste de domaines : Map domaine → valeur.
export async function loadQualifications(domains) {
  if (domains.length === 0) return new Map();
  const { rows } = await query(
    `SELECT domain, usage_commercial FROM domain_profile
      WHERE domain = ANY($1) AND usage_commercial IS NOT NULL`,
    [[...new Set(domains)]],
  );
  return new Map(rows.map((r) => [r.domain, r.usage_commercial]));
}

// Le compte porte sur les URLs normalisées ou classées : une URL en attente n'a
// pas encore de domaine en base.
export async function listDomains({ toQualify = false, limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT dp.domain, dp.usage_commercial, dp.first_seen_at, dp.first_query, dp.explore_excluded,
            count(ui.id)::int AS urls
       FROM domain_profile dp
       LEFT JOIN url_item ui ON ui.domain = dp.domain AND ui.status IN ('normalized', 'classified')
      WHERE NOT $1 OR dp.usage_commercial IS NULL
      GROUP BY dp.domain
      ORDER BY urls DESC, dp.domain
      LIMIT $2`,
    [toQualify, limit],
  );
  return rows;
}

// Qualifie un domaine et réécrit la facette de ses URLs classées, sans reclasser.
// Une base jamais classée n'a pas encore la facette : seul le registre est écrit.
export async function qualifyDomain({ domain, usage, note }) {
  assertUsage(usage);
  const name = normalizeDomain(domain);
  return withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE domain_profile
          SET usage_commercial = $2, note = coalesce($3, note), reviewed_at = now()
        WHERE domain = $1`,
      [name, usage, note ?? null],
    );
    if (updated.rowCount === 0) throw new Error(`Domaine inconnu du registre : ${name}`);

    const { rows } = await client.query('SELECT id FROM facet_definition WHERE slug = $1', [USAGE_FACET]);
    if (rows.length === 0) return { domain: name, usage, rewritten: null };
    const rewritten = await client.query(
      `INSERT INTO url_facet_value (url_item_id, facet_id, value)
       SELECT id, $2, $3 FROM url_item WHERE domain = $1 AND status = 'classified'
       ON CONFLICT (url_item_id, facet_id) DO UPDATE SET value = EXCLUDED.value`,
      [name, rows[0].id, usage],
    );
    return { domain: name, usage, rewritten: rewritten.rowCount };
  });
}

// Exclusion manuelle de l'exploration : un domaine encore jamais vu peut être
// exclu d'avance ; réintégrer un domaine inconnu est une erreur.
export async function setExploreExcluded({ domain, excluded }) {
  const name = normalizeDomain(domain);
  if (!name) throw new Error('--domain requis');
  if (excluded) {
    await query(
      `INSERT INTO domain_profile (domain, explore_excluded) VALUES ($1, true)
       ON CONFLICT (domain) DO UPDATE SET explore_excluded = true`,
      [name],
    );
  } else {
    const { rowCount } = await query('UPDATE domain_profile SET explore_excluded = false WHERE domain = $1', [name]);
    if (rowCount === 0) throw new Error(`Domaine inconnu du registre : ${name}`);
  }
  return { domain: name, excluded };
}
