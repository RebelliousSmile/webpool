import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import { providers } from '../ingest/index.js';
import { giriFromCents, parseCallCosts, priceList } from './pricing.js';

// Communautés, portefeuilles et grand livre des giri.

// Erreur métier : `code` est repris par l'API (statut HTTP) ; le CLI n'affiche que le message.
export class BillingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const ROLES = ['owner', 'member'];

// Grille du moment, d'après la configuration.
export function currentPrices(cfg = config) {
  return priceList({
    providers: cfg.requestProviders,
    available: Object.keys(providers),
    engine: cfg.openrouterEngine,
    overrides: parseCallCosts(cfg.callCostsUsd),
    usdEur: cfg.usdEur,
    markup: cfg.priceMarkup,
    giriPerEur: cfg.giriPerEur,
    maxPages: cfg.requestMaxPages,
  });
}

// --- Communautés

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export async function addCommunity({ slug, label }) {
  if (!SLUG_RE.test(slug ?? '')) throw new BillingError('invalid', `Slug de communauté invalide : "${slug}" (minuscules, chiffres, tirets)`);
  const { rows } = await query(
    `INSERT INTO community (slug, label) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING RETURNING id`,
    [slug, label ?? slug],
  );
  if (rows.length === 0) throw new BillingError('invalid', `Communauté existante : ${slug}`);
  return { id: Number(rows[0].id), slug, label: label ?? slug };
}

export async function listCommunities() {
  const { rows } = await query(
    `SELECT c.slug, c.label, coalesce(w.balance, 0)::bigint AS balance,
            (SELECT coalesce(array_agg(ac.name || ':' || cm.role ORDER BY cm.role DESC, ac.name), '{}')
               FROM community_member cm JOIN api_client ac ON ac.id = cm.api_client_id
              WHERE cm.community_id = c.id) AS members,
            (SELECT coalesce(array_agg(p.slug ORDER BY p.slug), '{}')
               FROM community_pool cp JOIN pool p ON p.id = cp.pool_id
              WHERE cp.community_id = c.id) AS pools
       FROM community c LEFT JOIN wallet w ON w.community_id = c.id
      ORDER BY c.slug`,
  );
  return rows.map((r) => ({ ...r, balance: Number(r.balance) }));
}

async function ids({ name, community, pool }) {
  const { rows } = await query(
    `SELECT (SELECT id FROM api_client WHERE name = $1) AS client_id,
            (SELECT id FROM community WHERE slug = $2) AS community_id,
            (SELECT id FROM pool WHERE slug = $3) AS pool_id`,
    [name ?? null, community ?? null, pool ?? null],
  );
  const r = rows[0];
  if (name !== undefined && r.client_id === null) throw new BillingError('not_found', `Client inconnu : ${name}`);
  if (community !== undefined && r.community_id === null) throw new BillingError('not_found', `Communauté inconnue : ${community}`);
  if (pool !== undefined && r.pool_id === null) throw new BillingError('not_found', `Pool inconnu : ${pool}`);
  return { clientId: r.client_id, communityId: r.community_id, poolId: r.pool_id };
}

// Upsert partiel d'un membre : un champ `undefined` garde sa valeur (rôle
// `member` et sans plafond pour un nouveau membre) ; `monthlyLimit: null` lève
// le plafond, 0 bloque toute dépense.
const UPSERT_MEMBER = `
  INSERT INTO community_member (community_id, api_client_id, role, monthly_limit)
  VALUES ($1, $2, coalesce($3, 'member'), $4)
  ON CONFLICT (community_id, api_client_id) DO UPDATE
     SET role = coalesce($3, community_member.role),
         monthly_limit = CASE WHEN $5 THEN $4 ELSE community_member.monthly_limit END
  RETURNING role, monthly_limit`;

function checkMemberFields(role, monthlyLimit) {
  if (role !== undefined && !ROLES.includes(role)) {
    throw new BillingError('invalid', `role invalide : "${role}" (attendu : ${ROLES.join(', ')})`);
  }
  if (monthlyLimit !== undefined && monthlyLimit !== null && (!Number.isInteger(monthlyLimit) || monthlyLimit < 0)) {
    throw new BillingError('invalid', 'plafond mensuel : entier ≥ 0, ou null (sans plafond)');
  }
}

const memberRow = (r) => ({ role: r.role, monthlyLimit: r.monthly_limit === null ? null : Number(r.monthly_limit) });

// Ajoute un membre, ou change son rôle ou son plafond s'il l'est déjà (admin).
export async function setMember({ community, name, role, monthlyLimit }) {
  checkMemberFields(role, monthlyLimit);
  const { clientId, communityId } = await ids({ name, community });
  const { rows } = await query(UPSERT_MEMBER, [communityId, clientId, role ?? null, monthlyLimit ?? null, monthlyLimit !== undefined]);
  return { community, name, ...memberRow(rows[0]) };
}

export async function removeMember({ community, name }) {
  const { clientId, communityId } = await ids({ name, community });
  const { rowCount } = await query('DELETE FROM community_member WHERE community_id = $1 AND api_client_id = $2', [communityId, clientId]);
  if (rowCount === 0) throw new BillingError('not_found', `${name} n'est pas membre de ${community}`);
  return { community, name };
}

export async function setCommunityPool({ community, pool, attached }) {
  const { communityId, poolId } = await ids({ community, pool });
  await query(
    attached
      ? 'INSERT INTO community_pool (community_id, pool_id) VALUES ($1, $2) ON CONFLICT DO NOTHING'
      : 'DELETE FROM community_pool WHERE community_id = $1 AND pool_id = $2',
    [communityId, poolId],
  );
  return { community, pool, attached };
}

// --- Portefeuilles

// Portefeuille du client ou de la communauté, créé au premier besoin.
export async function ensureWallet(db, { clientId = null, communityId = null }) {
  const column = clientId !== null ? 'api_client_id' : 'community_id';
  const owner = clientId ?? communityId;
  await db.query(`INSERT INTO wallet (${column}) VALUES ($1) ON CONFLICT (${column}) DO NOTHING`, [owner]);
  const { rows } = await db.query(`SELECT id, balance FROM wallet WHERE ${column} = $1`, [owner]);
  return { id: Number(rows[0].id), balance: Number(rows[0].balance) };
}

// Mouvement du grand livre et solde, dans la transaction `db`. Un débit qui
// dépasserait le solde ne touche à rien et renvoie null.
export async function postEntry(db, { walletId, delta, kind, amountCents = null, reference = null, requestId = null, clientId = null, note = null }) {
  const { rows } = await db.query(
    'UPDATE wallet SET balance = balance + $2 WHERE id = $1 AND balance + $2 >= 0 RETURNING balance',
    [walletId, delta],
  );
  if (rows.length === 0) return null;
  await db.query(
    `INSERT INTO wallet_entry (wallet_id, delta, kind, amount_cents, reference, search_request_id, api_client_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [walletId, delta, kind, amountCents, reference, requestId, clientId, note],
  );
  return Number(rows[0].balance);
}

async function ownerIds({ name, community }) {
  if ((name === undefined) === (community === undefined)) {
    throw new BillingError('invalid', 'Un portefeuille : --name (client) ou --community (apport : --community et --by), pas les deux');
  }
  return ids(name !== undefined ? { name } : { community });
}

// Don (portefeuille personnel d'un client) ou apport à une communauté (pot
// commun), saisi par l'admin à réception du paiement. Dans une communauté, on ne
// paie pas pour soi : un membre verse au pot, et `contributor` garde son nom.
// `reference` identifie le paiement : le même n'est jamais crédité deux fois.
export async function credit({
  name, community, contributor, cents, reference, note = null,
  giriPerEur = config.giriPerEur, minCents = config.minCreditCents, force = false,
}) {
  if (!reference?.trim()) throw new BillingError('invalid', '--ref requis : référence du paiement reçu (ex. liberapay:1234)');
  if (contributor !== undefined && community === undefined) {
    throw new BillingError('invalid', '--by : apport à une communauté seulement (avec --community)');
  }
  const { clientId, communityId } = await ownerIds({ name, community });
  let contributorId = null;
  if (contributor !== undefined) {
    const { rows } = await query(
      `SELECT ac.id FROM api_client ac JOIN community_member cm ON cm.api_client_id = ac.id
        WHERE ac.name = $1 AND cm.community_id = $2`,
      [contributor, communityId],
    );
    if (rows.length === 0) throw new BillingError('not_found', `${contributor} n'est pas membre de ${community}`);
    contributorId = Number(rows[0].id);
  }
  if (cents < minCents && !force) {
    throw new BillingError('invalid', `Montant sous le minimum de ${(minCents / 100).toFixed(2)} € (frais de paiement) : --force pour créditer quand même`);
  }
  const giri = giriFromCents(cents, giriPerEur);
  if (giri < 1) throw new BillingError('invalid', 'Montant trop faible pour un giri');
  const kind = clientId !== null ? 'donation' : 'purchase';
  return withTransaction(async (db) => {
    const { rows: dup } = await db.query('SELECT 1 FROM wallet_entry WHERE reference = $1', [reference.trim()]);
    if (dup.length) throw new BillingError('invalid', `Paiement déjà crédité : ${reference.trim()}`);
    const wallet = await ensureWallet(db, { clientId, communityId });
    const balance = await postEntry(db, {
      walletId: wallet.id,
      delta: giri,
      kind,
      amountCents: cents,
      reference: reference.trim(),
      clientId: contributorId,
      note,
    });
    return { giri, balance, kind };
  });
}

// Correction manuelle, positive ou négative (jamais sous zéro).
export async function adjust({ name, community, giri, note }) {
  if (!Number.isInteger(giri) || giri === 0) throw new BillingError('invalid', '--giri doit être un entier non nul');
  if (!note?.trim()) throw new BillingError('invalid', '--note requis : motif de la correction');
  const { clientId, communityId } = await ownerIds({ name, community });
  return withTransaction(async (db) => {
    const wallet = await ensureWallet(db, { clientId, communityId });
    const balance = await postEntry(db, { walletId: wallet.id, delta: giri, kind: 'adjustment', note: note.trim() });
    if (balance === null) throw new BillingError('insufficient_balance', `Solde insuffisant : ${wallet.balance} giri`);
    return { giri, balance };
  });
}

// Solde et dernières écritures d'un portefeuille.
export async function walletEntries({ walletId, limit = 50, offset = 0 }) {
  const [{ rows }, { rows: count }] = await Promise.all([
    query(
      `SELECT e.id, e.delta, e.kind, e.amount_cents, e.reference, e.search_request_id, ac.name AS client, e.note, e.created_at
         FROM wallet_entry e LEFT JOIN api_client ac ON ac.id = e.api_client_id
        WHERE e.wallet_id = $1 ORDER BY e.id DESC LIMIT $2 OFFSET $3`,
      [walletId, limit, offset],
    ),
    query('SELECT count(*)::int AS n FROM wallet_entry WHERE wallet_id = $1', [walletId]),
  ]);
  return {
    items: rows.map((r) => ({ ...r, id: Number(r.id), delta: Number(r.delta), search_request_id: r.search_request_id === null ? null : Number(r.search_request_id) })),
    total: count[0].n,
  };
}

export async function walletOf({ name, community }) {
  const { clientId, communityId } = await ownerIds({ name, community });
  return ensureWallet({ query }, { clientId, communityId });
}

// Dépense d'un membre sur le portefeuille d'une communauté, sur 30 jours
// glissants : débits moins remboursements.
export async function spentLast30Days(db, { walletId, clientId }) {
  const { rows } = await db.query(
    `SELECT greatest(0, -coalesce(sum(delta), 0))::bigint AS spent FROM wallet_entry
      WHERE wallet_id = $1 AND api_client_id = $2 AND kind IN ('debit', 'refund')
        AND created_at > now() - interval '30 days'`,
    [walletId, clientId],
  );
  return Number(rows[0].spent);
}

// Portefeuilles accessibles à un client : le sien, puis ceux de ses communautés.
export async function walletsFor(clientId) {
  const personal = await ensureWallet({ query }, { clientId });
  // Une requête : dépense du membre sur 30 jours (débits moins remboursements)
  // et ses apports au pot commun (versements à son nom).
  const { rows } = await query(
    `SELECT c.slug, c.label, cm.role, cm.monthly_limit, coalesce(w.balance, 0) AS balance,
            (SELECT coalesce(array_agg(p.slug ORDER BY p.slug), '{}')
               FROM community_pool cp JOIN pool p ON p.id = cp.pool_id WHERE cp.community_id = c.id) AS pools,
            greatest(0, -coalesce((SELECT sum(e.delta) FROM wallet_entry e
                                    WHERE e.wallet_id = w.id AND e.api_client_id = $1 AND e.kind IN ('debit', 'refund')
                                      AND e.created_at > now() - interval '30 days'), 0))::bigint AS spent_30d,
            coalesce((SELECT sum(e.delta) FROM wallet_entry e
                       WHERE e.wallet_id = w.id AND e.api_client_id = $1 AND e.kind = 'purchase'), 0)::bigint AS contributed
       FROM community_member cm
       JOIN community c ON c.id = cm.community_id
       LEFT JOIN wallet w ON w.community_id = c.id
      WHERE cm.api_client_id = $1
      ORDER BY c.slug`,
    [clientId],
  );
  const communities = rows.map((r) => ({
    slug: r.slug,
    label: r.label,
    role: r.role,
    balance: Number(r.balance),
    monthly_limit: r.monthly_limit === null ? null : Number(r.monthly_limit),
    spent_30d: Number(r.spent_30d),
    contributed: Number(r.contributed),
    pools: r.pools,
  }));
  return { personal: { balance: personal.balance }, communities };
}

// Recettes et dépenses sur `days` jours : giri crédités (et €), giri dépensés
// net des remboursements, coût des providers, par provider.
export async function billingReport({ days = 30, usdEur = config.usdEur, giriPerEur = config.giriPerEur } = {}) {
  const [{ rows: credits }, { rows: byProvider }, { rows: outstanding }] = await Promise.all([
    query(
      `SELECT kind, count(*)::int AS entries, sum(delta)::bigint AS giri, coalesce(sum(amount_cents), 0)::bigint AS cents
         FROM wallet_entry WHERE kind IN ('donation', 'purchase') AND created_at > now() - make_interval(days => $1)
        GROUP BY kind ORDER BY kind`,
      [days],
    ),
    query(
      `SELECT provider, count(*)::int AS requests, sum(calls_done)::int AS calls,
              sum(price - refunded)::bigint AS giri, sum(cost_usd)::float8 AS cost_usd
         FROM search_request WHERE created_at > now() - make_interval(days => $1) AND status <> 'queued'
        GROUP BY provider ORDER BY provider`,
      [days],
    ),
    // Encours : giri crédités et pas encore dépensés, dus en recherches (ils n'expirent pas).
    query(
      `SELECT coalesce(sum(balance) FILTER (WHERE api_client_id IS NOT NULL), 0)::bigint AS personal,
              coalesce(sum(balance) FILTER (WHERE community_id IS NOT NULL), 0)::bigint AS communities
         FROM wallet`,
    ),
  ]);
  const providersOut = byProvider.map((r) => {
    const revenueEur = Number(r.giri) / giriPerEur;
    const costEur = r.cost_usd * usdEur;
    return {
      provider: r.provider,
      requests: r.requests,
      calls: r.calls,
      giri: Number(r.giri),
      revenue_eur: revenueEur,
      cost_usd: r.cost_usd,
      margin_eur: revenueEur - costEur,
    };
  });
  const owed = { personal: Number(outstanding[0].personal), communities: Number(outstanding[0].communities) };
  return {
    days,
    outstanding: { ...owed, eur: (owed.personal + owed.communities) / giriPerEur },
    credits: credits.map((c) => ({ kind: c.kind, entries: c.entries, giri: Number(c.giri), eur: Number(c.cents) / 100 })),
    providers: providersOut,
  };
}

// --- Gestion d'une communauté par ses propriétaires (API)

// Communauté dont `clientId` est propriétaire ; sinon introuvable (son existence
// n'est pas révélée aux autres).
async function ownedCommunity(db, { clientId, community }) {
  const { rows } = await db.query(
    `SELECT c.id FROM community c
       JOIN community_member cm ON cm.community_id = c.id AND cm.api_client_id = $2 AND cm.role = 'owner'
      WHERE c.slug = $1`,
    [community, clientId],
  );
  if (rows.length === 0) throw new BillingError('not_found', `Communauté inconnue ou réservée à ses propriétaires : ${community}`);
  return Number(rows[0].id);
}

// Membres, avec leur dépense sur 30 jours et leurs apports au pot commun.
export async function listMembers({ clientId, community }) {
  const communityId = await ownedCommunity({ query }, { clientId, community });
  const { rows } = await query(
    `SELECT ac.name, cm.role, cm.monthly_limit, cm.joined_at, ac.revoked_at IS NOT NULL AS revoked,
            greatest(0, -coalesce((SELECT sum(e.delta) FROM wallet_entry e JOIN wallet w ON w.id = e.wallet_id
                                    WHERE w.community_id = cm.community_id AND e.api_client_id = cm.api_client_id
                                      AND e.kind IN ('debit', 'refund') AND e.created_at > now() - interval '30 days'), 0))::bigint AS spent_30d,
            coalesce((SELECT sum(e.delta) FROM wallet_entry e JOIN wallet w ON w.id = e.wallet_id
                       WHERE w.community_id = cm.community_id AND e.api_client_id = cm.api_client_id
                         AND e.kind = 'purchase'), 0)::bigint AS contributed
       FROM community_member cm JOIN api_client ac ON ac.id = cm.api_client_id
      WHERE cm.community_id = $1
      ORDER BY cm.role DESC, ac.name`,
    [communityId],
  );
  return rows.map((r) => ({
    name: r.name,
    role: r.role,
    monthly_limit: r.monthly_limit === null ? null : Number(r.monthly_limit),
    spent_30d: Number(r.spent_30d),
    contributed: Number(r.contributed),
    revoked: r.revoked,
    joined_at: r.joined_at,
  }));
}

// Une communauté garde au moins un propriétaire : sinon plus personne ne la gère.
async function assertOwnerLeft(db, communityId, name) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM community_member cm JOIN api_client ac ON ac.id = cm.api_client_id
      WHERE cm.community_id = $1 AND cm.role = 'owner' AND ac.name <> $2 AND ac.revoked_at IS NULL`,
    [communityId, name],
  );
  if (rows[0].n === 0) throw new BillingError('invalid', 'La communauté doit garder au moins un propriétaire actif');
}

// Ajoute un membre ou change son rôle ou son plafond, par un propriétaire (upsert partiel).
export async function ownerSetMember({ clientId, community, name, role, monthlyLimit }) {
  checkMemberFields(role, monthlyLimit);
  return withTransaction(async (db) => {
    const communityId = await ownedCommunity(db, { clientId, community });
    // Sérialise les changements de rôle : la garde du dernier propriétaire reste juste.
    await db.query('SELECT 1 FROM community WHERE id = $1 FOR UPDATE', [communityId]);
    const { rows } = await db.query('SELECT id FROM api_client WHERE name = $1 AND revoked_at IS NULL', [name]);
    if (rows.length === 0) throw new BillingError('not_found', `Client inconnu ou révoqué : ${name}`);
    if (role === 'member') await assertOwnerLeft(db, communityId, name);
    const { rows: set } = await db.query(UPSERT_MEMBER, [communityId, rows[0].id, role ?? null, monthlyLimit ?? null, monthlyLimit !== undefined]);
    const m = memberRow(set[0]);
    return { community, name, role: m.role, monthly_limit: m.monthlyLimit };
  });
}

export async function ownerRemoveMember({ clientId, community, name }) {
  return withTransaction(async (db) => {
    const communityId = await ownedCommunity(db, { clientId, community });
    await db.query('SELECT 1 FROM community WHERE id = $1 FOR UPDATE', [communityId]);
    await assertOwnerLeft(db, communityId, name);
    const { rowCount } = await db.query(
      `DELETE FROM community_member WHERE community_id = $1
          AND api_client_id = (SELECT id FROM api_client WHERE name = $2)`,
      [communityId, name],
    );
    if (rowCount === 0) throw new BillingError('not_found', `${name} n'est pas membre de ${community}`);
    return { community, name };
  });
}
