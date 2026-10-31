import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { query } from '../db.js';
import { MEDIA_FILE_RE, mediaUrl } from '../media/files.js';
import { mediaOf, sourceOf } from '../media/kinds.js';
import { stats } from '../stats.js';
import { USAGE_VALUES } from '../domains/index.js';
import { QUERY_STATUSES, listQueries } from '../explore/index.js';
import { formatPool, FORMATS } from '../pools/export.js';
import { loadPoolForExport } from '../pools/index.js';
import {
  BillingError, currentPrices, listMembers, ownerRemoveMember, ownerSetMember, walletEntries, walletsFor,
} from '../billing/index.js';
import { REQUEST_STATUSES, cancelRequest, createRequest, listRequests } from '../requests/index.js';
import {
  ApiError,
  badRequest,
  boolParam,
  enumParam,
  facetParams,
  idParam,
  likePattern,
  notFound,
  num,
  pageParams,
  paged,
} from './params.js';

// Handlers de l'API. Chacun reçoit { client, params, query, body } et renvoie
// { body } (JSON) ou { raw, contentType, filename }.

const URL_STATUSES = ['pending', 'normalized', 'classified', 'duplicate', 'error'];
const RUN_KINDS = ['ingest', 'normalize', 'classify', 'pool', 'explore', 'media', 'request'];
const RUN_STATUSES = ['running', 'done', 'failed'];
const URL_ORDERS = {
  recent: 'ui.first_seen_at DESC, ui.id DESC',
  quality: 'ui.quality_score DESC NULLS LAST, ui.id',
  relevance: 'ui.relevance_score DESC NULLS LAST, ui.id',
};
const TOP_DOMAINS = 20;

const iso = (d) => (d ? new Date(d).toISOString() : null);

// Médias d'un lien : vignette en cache (aperçu de la page d'abord, puis celle du
// provider), favicon du domaine, type et famille de source. Le type d'une URL
// normalisée avant la phase 3 se déduit de son URL.
const THUMB_SQL = `(SELECT m.file FROM url_media m
                     WHERE m.url_item_id = ui.id AND m.status = 'cached'
                     ORDER BY m.kind = 'og' DESC LIMIT 1) AS thumb_file`;
const FAVICON_SQL = `(SELECT f.favicon_file FROM domain_profile f
                       WHERE f.domain = ui.domain AND f.favicon_status = 'cached') AS favicon_file`;
const mediaFields = (r, url) => ({
  description: r.description ?? null,
  media_type: r.media_type ?? mediaOf(url),
  source: sourceOf(r.domain),
  thumbnail: mediaUrl(r.thumb_file),
  favicon: mediaUrl(r.favicon_file),
});
const isAdmin = (client) => client.scope === 'admin';

// Page d'une requête filtrée : les fragments SQL sont des constantes du module,
// les valeurs sont toujours paramétrées.
async function selectPage({ select, from, where, values, order, page }) {
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [{ rows }, { rows: countRows }] = await Promise.all([
    query(
      `SELECT ${select} FROM ${from} ${clause} ORDER BY ${order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, page.limit, page.offset],
    ),
    query(`SELECT count(*)::int AS n FROM ${from} ${clause}`, values),
  ]);
  return { rows, total: countRows[0].n };
}

// La version et le commit déployé permettent au déploiement de vérifier que le
// nouveau code sert après redémarrage.
export async function health() {
  await query('SELECT 1');
  return { body: { ok: true, version: config.version, revision: config.revision } };
}

export async function me({ client }) {
  return { body: { name: client.name, scope: client.scope } };
}

// --- Pools : visibles par l'admin ; pour un client `read`, les pools publics,
// ceux qui lui sont accordés et ceux de ses communautés.

const GRANTED_SQL = (clientParam) => `(p.public
         OR EXISTS (SELECT 1 FROM api_client_pool cp WHERE cp.pool_id = p.id AND cp.api_client_id = ${clientParam})
         OR EXISTS (SELECT 1 FROM community_pool cp JOIN community_member cm ON cm.community_id = cp.community_id
                     WHERE cp.pool_id = p.id AND cm.api_client_id = ${clientParam}))`;

async function visiblePool(client, slug) {
  const { rows } = await query(
    `SELECT p.id, p.slug, p.label, p.public, p.definition, p.created_at, p.refreshed_at
       FROM pool p
      WHERE p.slug = $1
        AND ($2 OR ${GRANTED_SQL('$3')})`,
    [slug, isAdmin(client), client.id],
  );
  // Un pool non accordé est introuvable : son existence n'est pas révélée.
  if (rows.length === 0) throw notFound(`Pool inconnu : ${slug}`);
  return rows[0];
}

export async function listPools({ client }) {
  const { rows } = await query(
    `SELECT p.slug, p.label, p.public, p.refreshed_at, count(pi.url_item_id)::int AS items
       FROM pool p
       LEFT JOIN pool_item pi ON pi.pool_id = p.id
      WHERE $1 OR ${GRANTED_SQL('$2')}
      GROUP BY p.id ORDER BY p.slug`,
    [isAdmin(client), client.id],
  );
  return { body: { items: rows.map((r) => ({ ...r, refreshed_at: iso(r.refreshed_at) })) } };
}

export async function getPool({ client, params }) {
  const pool = await visiblePool(client, params.slug);
  const [{ rows: domains }, { rows: usage }] = await Promise.all([
    query(
      `SELECT ui.domain, count(*)::int AS urls
         FROM pool_item pi JOIN url_item ui ON ui.id = pi.url_item_id
        WHERE pi.pool_id = $1
        GROUP BY ui.domain ORDER BY urls DESC, ui.domain LIMIT $2`,
      [pool.id, TOP_DOMAINS],
    ),
    query(
      `SELECT dp.usage_commercial AS usage, count(*)::int AS urls
         FROM pool_item pi
         JOIN url_item ui ON ui.id = pi.url_item_id
         LEFT JOIN domain_profile dp ON dp.domain = ui.domain
        WHERE pi.pool_id = $1
        GROUP BY dp.usage_commercial ORDER BY urls DESC`,
      [pool.id],
    ),
  ]);
  const body = {
    slug: pool.slug,
    label: pool.label,
    public: pool.public,
    refreshed_at: iso(pool.refreshed_at),
    items: usage.reduce((n, u) => n + u.urls, 0),
    top_domains: domains,
    usage_commercial: usage,
  };
  // Les critères de sélection restent internes.
  if (isAdmin(client)) Object.assign(body, { created_at: iso(pool.created_at), definition: pool.definition });
  return { body };
}

export async function listPoolItems({ client, params, query: qs }) {
  const pool = await visiblePool(client, params.slug);
  const page = pageParams(qs);
  const { rows, total } = await selectPage({
    select: `pi.rank, pi.score, ui.id, ui.canonical_url, ui.domain, ui.title, dp.usage_commercial,
             ui.description, ui.media_type, ${THUMB_SQL}, ${FAVICON_SQL}`,
    from: `pool_item pi
           JOIN url_item ui ON ui.id = pi.url_item_id
           LEFT JOIN domain_profile dp ON dp.domain = ui.domain`,
    where: ['pi.pool_id = $1'],
    values: [pool.id],
    order: 'pi.rank',
    page,
  });
  const items = rows.map((r) => {
    const item = {
      rank: r.rank,
      url: r.canonical_url,
      domain: r.domain,
      title: r.title,
      usage_commercial: r.usage_commercial,
      ...mediaFields(r, r.canonical_url),
    };
    return isAdmin(client) ? { ...item, id: num(r.id), score: num(r.score) } : item;
  });
  return { body: paged(items, total, page) };
}

const EXPORT_TYPES = { json: 'application/json', csv: 'text/csv', md: 'text/markdown', txt: 'text/plain' };

// Export admin : définition et scores compris.
export async function exportPool({ params, query: qs }) {
  return exportResponse(params.slug, enumParam(qs, 'format', FORMATS) ?? 'json', { client: false });
}

// Export d'un pool visible par le client (accordé, ou tout pool pour l'admin),
// sans définition ni score : les critères de sélection restent internes.
export async function exportVisiblePool({ client, params, query: qs }) {
  const format = enumParam(qs, 'format', FORMATS) ?? 'json';
  await visiblePool(client, params.slug);
  return exportResponse(params.slug, format, { client: true });
}

async function exportResponse(slug, format, { client }) {
  let data;
  try {
    data = await loadPoolForExport(slug);
  } catch (err) {
    if (err.message.startsWith('Pool inconnu')) throw notFound(err.message);
    throw err;
  }
  return {
    raw: formatPool(data, format, { client }),
    contentType: `${EXPORT_TYPES[format]}; charset=utf-8`,
    filename: `${slug.replace(/[^\w.-]/g, '_')}.${format}`,
  };
}

// --- Administration : corpus, taxonomie, domaines, frontière, runs.

export async function adminStats() {
  const [base, { rows: pools }, { rows: domains }, { rows: queries }, { rows: media }] = await Promise.all([
    stats(),
    query('SELECT count(*)::int AS n FROM pool'),
    query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE usage_commercial IS NULL)::int AS to_qualify,
              count(*) FILTER (WHERE explore_excluded)::int AS excluded
         FROM domain_profile`,
    ),
    query('SELECT status, count(*)::int AS n FROM search_query GROUP BY status ORDER BY status'),
    query(
      `SELECT 'thumbs' AS what, status, count(*)::int AS n FROM url_media GROUP BY status
       UNION ALL
       SELECT 'favicons', favicon_status, count(*)::int FROM domain_profile WHERE favicon_status IS NOT NULL GROUP BY favicon_status`,
    ),
  ]);
  const mediaStats = { thumbs: { pending: 0, cached: 0, failed: 0 }, favicons: { pending: 0, cached: 0, failed: 0 } };
  for (const m of media) mediaStats[m.what][m.status] = m.n;
  return { body: { ...base, pools: pools[0].n, domain_profile: domains[0], search_query: queries, media: mediaStats } };
}

export async function listUrls({ query: qs }) {
  const page = pageParams(qs);
  const status = enumParam(qs, 'status', URL_STATUSES);
  const order = enumParam(qs, 'order', Object.keys(URL_ORDERS)) ?? 'recent';
  const theme = qs.get('theme');
  const domain = qs.get('domain');
  const text = qs.get('q');
  const facets = facetParams(qs);

  const where = [];
  const values = [];
  const $ = (v) => `$${values.push(v)}`;
  if (status) where.push(`ui.status = ${$(status)}`);
  if (domain) where.push(`ui.domain = ${$(domain.toLowerCase())}`);
  if (theme) {
    where.push(
      `EXISTS (SELECT 1 FROM url_theme ut JOIN theme t ON t.id = ut.theme_id
                WHERE ut.url_item_id = ui.id AND t.slug = ${$(theme)})`,
    );
  }
  for (const f of facets) {
    where.push(
      `EXISTS (SELECT 1 FROM url_facet_value fv JOIN facet_definition fd ON fd.id = fv.facet_id
                WHERE fv.url_item_id = ui.id AND fd.slug = ${$(f.slug)} AND fv.value = ${$(f.value)})`,
    );
  }
  if (text) {
    const p = $(likePattern(text));
    where.push(`(ui.title ILIKE ${p} OR coalesce(ui.canonical_url, ui.raw_url) ILIKE ${p})`);
  }

  const { rows, total } = await selectPage({
    select: `ui.id, coalesce(ui.canonical_url, ui.raw_url) AS url, ui.domain, ui.title, ui.status,
             ui.relevance_score, ui.quality_score, ui.confidence_score, ui.first_seen_at,
             (SELECT d.usage_commercial FROM domain_profile d WHERE d.domain = ui.domain) AS usage_commercial,
             (SELECT t.slug FROM url_theme ut JOIN theme t ON t.id = ut.theme_id
               WHERE ut.url_item_id = ui.id AND ut.is_primary) AS primary_theme,
             ui.description, ui.media_type, ${THUMB_SQL}, ${FAVICON_SQL}`,
    from: 'url_item ui',
    where,
    values,
    order: URL_ORDERS[order],
    page,
  });
  const items = rows.map(({ thumb_file, favicon_file, ...r }) => ({
    ...r,
    id: num(r.id),
    relevance_score: num(r.relevance_score),
    quality_score: num(r.quality_score),
    confidence_score: num(r.confidence_score),
    first_seen_at: iso(r.first_seen_at),
    ...mediaFields({ ...r, thumb_file, favicon_file }, r.url),
  }));
  return { body: paged(items, total, page) };
}

export async function getUrl({ params }) {
  const id = idParam(params.id);
  const { rows } = await query(
    `SELECT ui.id, ui.raw_url, ui.canonical_url, ui.domain, ui.title, ui.http_status, ui.status,
            ui.duplicate_of, ui.error, ui.relevance_score, ui.confidence_score, ui.quality_score,
            ui.first_seen_at, ui.normalized_at, ui.classified_at, dp.usage_commercial,
            ui.description, ui.media_type, ui.lang, ui.site_name, ${THUMB_SQL}, ${FAVICON_SQL}
       FROM url_item ui LEFT JOIN domain_profile dp ON dp.domain = ui.domain
      WHERE ui.id = $1`,
    [id],
  );
  if (rows.length === 0) throw notFound(`URL inconnue : ${id}`);
  const { thumb_file, favicon_file, ...r } = rows[0];
  const [{ rows: sources }, { rows: themes }, { rows: facets }, { rows: pools }] = await Promise.all([
    query(
      `SELECT provider, query, serp_rank, discovered_at FROM url_source
        WHERE url_item_id = $1 ORDER BY discovered_at, id`,
      [id],
    ),
    query(
      `SELECT t.slug, t.label, parent.slug AS parent, ut.is_primary, ut.score
         FROM url_theme ut JOIN theme t ON t.id = ut.theme_id LEFT JOIN theme parent ON parent.id = t.parent_id
        WHERE ut.url_item_id = $1 ORDER BY ut.is_primary DESC, ut.score DESC NULLS LAST, t.slug`,
      [id],
    ),
    query(
      `SELECT fd.slug, fd.label, fv.value
         FROM url_facet_value fv JOIN facet_definition fd ON fd.id = fv.facet_id
        WHERE fv.url_item_id = $1 ORDER BY fd.slug`,
      [id],
    ),
    query(
      `SELECT p.slug, pi.rank FROM pool_item pi JOIN pool p ON p.id = pi.pool_id
        WHERE pi.url_item_id = $1 ORDER BY p.slug`,
      [id],
    ),
  ]);
  return {
    body: {
      ...r,
      id: num(r.id),
      duplicate_of: num(r.duplicate_of),
      relevance_score: num(r.relevance_score),
      confidence_score: num(r.confidence_score),
      quality_score: num(r.quality_score),
      first_seen_at: iso(r.first_seen_at),
      normalized_at: iso(r.normalized_at),
      classified_at: iso(r.classified_at),
      ...mediaFields({ ...r, thumb_file, favicon_file }, r.canonical_url ?? r.raw_url),
      sources: sources.map((s) => ({ ...s, discovered_at: iso(s.discovered_at) })),
      themes: themes.map((t) => ({ ...t, score: num(t.score) })),
      facets,
      pools,
    },
  };
}

// Arbre de la taxonomie : `urls` compte les URLs rattachées, `primary_urls`
// celles dont c'est le thème principal.
export async function listThemes() {
  const { rows } = await query(
    `SELECT t.id, t.slug, t.label, t.parent_id,
            count(ut.url_item_id)::int AS urls,
            count(ut.url_item_id) FILTER (WHERE ut.is_primary)::int AS primary_urls
       FROM theme t LEFT JOIN url_theme ut ON ut.theme_id = t.id
      GROUP BY t.id ORDER BY t.id`,
  );
  const nodes = new Map(
    rows.map((r) => [r.id, { slug: r.slug, label: r.label, urls: r.urls, primary_urls: r.primary_urls, children: [] }]),
  );
  const roots = [];
  for (const r of rows) {
    const parent = r.parent_id === null ? null : nodes.get(r.parent_id);
    (parent ? parent.children : roots).push(nodes.get(r.id));
  }
  return { body: { items: roots } };
}

export async function listFacets() {
  const { rows } = await query(
    `SELECT fd.slug, fd.label, fv.value, count(fv.url_item_id)::int AS urls
       FROM facet_definition fd LEFT JOIN url_facet_value fv ON fv.facet_id = fd.id
      GROUP BY fd.id, fv.value ORDER BY fd.id, urls DESC, fv.value`,
  );
  const facets = new Map();
  for (const r of rows) {
    if (!facets.has(r.slug)) facets.set(r.slug, { slug: r.slug, label: r.label, values: [] });
    if (r.value !== null) facets.get(r.slug).values.push({ value: r.value, urls: r.urls });
  }
  return { body: { items: [...facets.values()] } };
}

export async function listDomains({ query: qs }) {
  const page = pageParams(qs);
  const toQualify = boolParam(qs, 'to_qualify');
  const excluded = boolParam(qs, 'excluded');
  const usage = enumParam(qs, 'usage', USAGE_VALUES);
  const text = qs.get('q');

  const where = [];
  const values = [];
  const $ = (v) => `$${values.push(v)}`;
  if (toQualify !== undefined) where.push(toQualify ? 'dp.usage_commercial IS NULL' : 'dp.usage_commercial IS NOT NULL');
  if (excluded !== undefined) where.push(`dp.explore_excluded = ${$(excluded)}`);
  if (usage) where.push(`dp.usage_commercial = ${$(usage)}`);
  if (text) where.push(`dp.domain ILIKE ${$(likePattern(text.toLowerCase()))}`);

  // Comme `webpool domain list` : seules les URLs normalisées ou classées comptent.
  const { rows, total } = await selectPage({
    select: `dp.domain, dp.usage_commercial, dp.note, dp.first_seen_at, dp.first_query, dp.reviewed_at,
             dp.explore_excluded,
             (SELECT count(*)::int FROM url_item ui
               WHERE ui.domain = dp.domain AND ui.status IN ('normalized', 'classified')) AS urls`,
    from: 'domain_profile dp',
    where,
    values,
    order: 'urls DESC, dp.domain',
    page,
  });
  const items = rows.map((r) => ({ ...r, first_seen_at: iso(r.first_seen_at), reviewed_at: iso(r.reviewed_at) }));
  return { body: paged(items, total, page) };
}

export async function listSearchQueries({ query: qs }) {
  const page = pageParams(qs);
  const status = enumParam(qs, 'status', QUERY_STATUSES);
  const provider = qs.get('provider');
  const all = (await listQueries({ status })).filter((q) => !provider || q.provider === provider);
  const items = all.slice(page.offset, page.offset + page.limit).map((q) => ({
    id: q.id,
    provider: q.provider,
    query: q.query,
    tags: q.tags,
    status: q.status,
    next_page: q.nextPage,
    runs: q.runs,
    dry_runs: q.dryRuns,
    new_domains: q.newDomains,
    // Infinity (requête jamais lancée) n'existe pas en JSON
    priority: Number.isFinite(q.priority) ? q.priority : null,
    last_run_at: iso(q.lastRunAt),
    exhausted_at: iso(q.exhaustedAt),
  }));
  return { body: paged(items, all.length, page) };
}

export async function listRuns({ query: qs }) {
  const page = pageParams(qs);
  const kind = enumParam(qs, 'kind', RUN_KINDS);
  const status = enumParam(qs, 'status', RUN_STATUSES);
  const where = [];
  const values = [];
  const $ = (v) => `$${values.push(v)}`;
  if (kind) where.push(`kind = ${$(kind)}`);
  if (status) where.push(`status = ${$(status)}`);
  const { rows, total } = await selectPage({
    select: 'id, kind, status, detail, started_at, finished_at',
    from: 'processing_run',
    where,
    values,
    order: 'id DESC',
    page,
  });
  const items = rows.map((r) => ({
    ...r,
    id: num(r.id),
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at),
  }));
  return { body: paged(items, total, page) };
}

// Fichier du cache de médias : public (une balise <img> n'envoie pas de jeton),
// immuable (nommé par son empreinte). Seul un nom d'empreinte est accepté :
// aucun autre chemin n'est lisible, et rien n'est jamais téléchargé ici.
export async function getMedia({ params }) {
  if (!MEDIA_FILE_RE.test(params.file)) throw notFound();
  let data;
  try {
    data = await fs.readFile(path.join(config.mediaDir, params.file));
  } catch (err) {
    if (err.code === 'ENOENT') throw notFound();
    throw err;
  }
  return {
    raw: data,
    contentType: 'image/webp',
    headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
  };
}

// --- Recherches payantes : prix, portefeuilles, recherches du client.

// Codes métier → statuts HTTP. 402 : il faut des giri (solde ou plafond).
const BILLING_STATUS = { invalid: 400, not_found: 404, insufficient_balance: 402, spend_limit: 402, too_many_queued: 429 };

async function billingCall(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BillingError) throw new ApiError(BILLING_STATUS[err.code] ?? 400, err.code, err.message);
    throw err;
  }
}

export async function billing({ client }) {
  const wallets = await walletsFor(client.id);
  return {
    body: {
      giri_per_eur: config.giriPerEur,
      funding_url: config.fundingUrl,
      max_queued: config.requestMaxQueued,
      prices: currentPrices().map(({ provider, unit_price, max_pages }) => ({ provider, unit_price, max_pages })),
      personal: wallets.personal,
      communities: wallets.communities,
    },
  };
}

// Communauté dont le client est membre (propriétaire si `owner`), sinon 404.
async function membership(client, slug, { owner = false } = {}) {
  const { rows } = await query(
    `SELECT c.id, cm.role, w.id AS wallet_id FROM community c
       JOIN community_member cm ON cm.community_id = c.id AND cm.api_client_id = $2
       LEFT JOIN wallet w ON w.community_id = c.id
      WHERE c.slug = $1`,
    [slug, client.id],
  );
  if (rows.length === 0 || (owner && rows[0].role !== 'owner')) {
    throw notFound(owner ? `Communauté inconnue ou réservée à ses propriétaires : ${slug}` : `Communauté inconnue : ${slug}`);
  }
  return { id: Number(rows[0].id), walletId: rows[0].wallet_id === null ? null : Number(rows[0].wallet_id) };
}

// Grand livre du portefeuille personnel, ou de la communauté pour ses propriétaires.
export async function listBillingEntries({ client, query: qs }) {
  const page = pageParams(qs);
  const community = qs.get('community');
  let walletId;
  if (community) {
    walletId = (await membership(client, community, { owner: true })).walletId;
  } else {
    const { rows } = await query('SELECT id FROM wallet WHERE api_client_id = $1', [client.id]);
    walletId = rows[0] ? Number(rows[0].id) : null;
  }
  if (walletId === null) return { body: paged([], 0, page) };
  const { items, total } = await walletEntries({ walletId, ...page });
  return { body: paged(items.map((e) => ({ ...e, created_at: iso(e.created_at) })), total, page) };
}

// Recherches du client, ou de toute la communauté pour ses propriétaires.
export async function listClientRequests({ client, query: qs }) {
  const page = pageParams(qs);
  const status = enumParam(qs, 'status', REQUEST_STATUSES);
  const community = qs.get('community');
  const scope = community ? { communityId: (await membership(client, community, { owner: true })).id } : { clientId: client.id };
  const { items, total } = await listRequests({ ...scope, status, ...page });
  return { body: paged(items, total, page) };
}

export async function postRequest({ client, body }) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw badRequest('Objet JSON attendu');
  const known = new Set(['query', 'provider', 'pages', 'pool', 'community']);
  const unknown = Object.keys(body).filter((k) => !known.has(k));
  if (unknown.length) throw badRequest(`Champ inconnu : ${unknown.join(', ')}`);
  for (const key of ['query', 'provider', 'pool', 'community']) {
    if (body[key] != null && typeof body[key] !== 'string') throw badRequest(`${key} doit être une chaîne`);
  }
  const res = await billingCall(() =>
    createRequest({
      clientId: client.id,
      isAdmin: isAdmin(client),
      provider: body.provider,
      query: body.query,
      pages: body.pages,
      pool: body.pool || undefined,
      community: body.community || undefined,
    }),
  );
  return { status: 201, body: res };
}

export async function deleteRequest({ client, params }) {
  const id = idParam(params.id);
  return { body: await billingCall(() => cancelRequest({ id, clientId: client.id })) };
}

// Toutes les recherches, pour l'admin.
export async function listAllRequests({ query: qs }) {
  const page = pageParams(qs);
  const status = enumParam(qs, 'status', REQUEST_STATUSES);
  const { items, total } = await listRequests({ status, ...page });
  return { body: paged(items, total, page) };
}

// --- Membres d'une communauté, gérés par ses propriétaires.

export async function listCommunityMembers({ client, params }) {
  const items = await billingCall(() => listMembers({ clientId: client.id, community: params.slug }));
  return { body: { items: items.map((m) => ({ ...m, joined_at: iso(m.joined_at) })) } };
}

export async function putCommunityMember({ client, params, body }) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw badRequest('Objet JSON attendu');
  const unknown = Object.keys(body).filter((k) => k !== 'role' && k !== 'monthly_limit');
  if (unknown.length) throw badRequest(`Champ inconnu : ${unknown.join(', ')}`);
  return {
    body: await billingCall(() =>
      ownerSetMember({
        clientId: client.id,
        community: params.slug,
        name: params.name,
        // champ absent : valeur gardée ; monthly_limit null : sans plafond
        role: body.role,
        monthlyLimit: body.monthly_limit,
      }),
    ),
  };
}

export async function deleteCommunityMember({ client, params }) {
  return { body: await billingCall(() => ownerRemoveMember({ clientId: client.id, community: params.slug, name: params.name })) };
}
