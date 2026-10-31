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
            (SELECT coalesce(array_agg(ac.name || ':' || CASE WHEN st.is_owner THEN 'owner' ELSE 'member' END
                                       || CASE WHEN cm.accepted_at IS NULL THEN ' (invité)' ELSE '' END
                                       || CASE WHEN st.contributed > 0 THEN ' ' || st.contributed || ' giri' ELSE '' END
                                       ORDER BY st.is_owner DESC, st.contributed DESC, ac.name), '{}')
               FROM community_member cm JOIN api_client ac ON ac.id = cm.api_client_id
               JOIN community_standing st ON st.community_id = cm.community_id AND st.api_client_id = cm.api_client_id
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
  INSERT INTO community_member (community_id, api_client_id, role, monthly_limit, accepted_at)
  VALUES ($1, $2, coalesce($3::text, 'member'), CASE WHEN $5::boolean THEN $4::bigint ELSE $7::bigint END,
          CASE WHEN $6::boolean THEN now() END)
  ON CONFLICT (community_id, api_client_id) DO UPDATE
     SET role = coalesce($3::text, community_member.role),
         monthly_limit = CASE WHEN $5::boolean THEN $4::bigint ELSE community_member.monthly_limit END,
         accepted_at = coalesce(community_member.accepted_at, CASE WHEN $6::boolean THEN now() END)
  RETURNING role, monthly_limit, accepted_at`;

// Plafond d'un nouveau membre sans plafond explicite : WEBPOOL_MEMBER_DEFAULT_LIMIT
// pour un membre, aucun pour un propriétaire.
const defaultLimit = (role) => (role === 'owner' ? null : config.memberDefaultLimit);

// Paramètres de UPSERT_MEMBER ; `accept` : membre actif d'office (admin), sinon invité.
const upsertParams = ({ communityId, clientId, role, monthlyLimit, accept }) => [
  communityId, clientId, role ?? null, monthlyLimit ?? null, monthlyLimit !== undefined, accept, defaultLimit(role ?? 'member'),
];

function checkMemberFields(role, monthlyLimit) {
  if (role !== undefined && !ROLES.includes(role)) {
    throw new BillingError('invalid', `role invalide : "${role}" (attendu : ${ROLES.join(', ')})`);
  }
  if (monthlyLimit !== undefined && monthlyLimit !== null && (!Number.isInteger(monthlyLimit) || monthlyLimit < 0)) {
    throw new BillingError('invalid', 'plafond mensuel : entier ≥ 0, ou null (sans plafond)');
  }
}

const memberRow = (r) => ({
  role: r.role,
  monthlyLimit: r.monthly_limit === null ? null : Number(r.monthly_limit),
  accepted: r.accepted_at !== null,
});

// Ajoute un membre, ou change son rôle ou son plafond s'il l'est déjà (admin :
// membre actif d'office, sans invitation).
export async function setMember({ community, name, role, monthlyLimit }) {
  checkMemberFields(role, monthlyLimit);
  const { clientId, communityId } = await ids({ name, community });
  const { rows } = await query(UPSERT_MEMBER, upsertParams({ communityId, clientId, role, monthlyLimit, accept: true }));
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
        WHERE ac.name = $1 AND cm.community_id = $2 AND cm.accepted_at IS NOT NULL`,
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
  return withUniqueReference(reference.trim(), () => withTransaction(async (db) => {
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
  }));
}

// Deux crédits simultanés de la même référence : la contrainte UNIQUE refuse
// le second (23505), traduit en erreur métier.
async function withUniqueReference(reference, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'wallet_entry_reference_key') {
      throw new BillingError('invalid', `Paiement déjà crédité : ${reference}`);
    }
    throw err;
  }
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
  // Lecture seule : un portefeuille absent vaut 0, il naît au premier crédit ou achat.
  const { rows: own } = await query('SELECT balance FROM wallet WHERE api_client_id = $1', [clientId]);
  const personal = { balance: own[0] ? Number(own[0].balance) : 0 };
  // Une requête : dépense du membre sur 30 jours (débits moins remboursements)
  // et ses apports au pot commun (versements à son nom).
  const { rows } = await query(
    `SELECT c.slug, c.label, st.is_owner, cm.monthly_limit, coalesce(w.balance, 0) AS balance,
            (SELECT coalesce(array_agg(p.slug ORDER BY p.slug), '{}')
               FROM community_pool cp JOIN pool p ON p.id = cp.pool_id WHERE cp.community_id = c.id) AS pools,
            greatest(0, -coalesce((SELECT sum(e.delta) FROM wallet_entry e
                                    WHERE e.wallet_id = w.id AND e.api_client_id = $1 AND e.kind IN ('debit', 'refund')
                                      AND e.created_at > now() - interval '30 days'), 0))::bigint AS spent_30d,
            coalesce((SELECT sum(e.delta) FROM wallet_entry e
                       WHERE e.wallet_id = w.id AND e.api_client_id = $1 AND e.kind = 'purchase'), 0)::bigint AS contributed
       FROM community_member cm
       JOIN community c ON c.id = cm.community_id
       JOIN community_standing st ON st.community_id = cm.community_id AND st.api_client_id = cm.api_client_id
       LEFT JOIN wallet w ON w.community_id = c.id
      WHERE cm.api_client_id = $1 AND cm.accepted_at IS NOT NULL
      ORDER BY c.slug`,
    [clientId],
  );
  const communities = rows.map((r) => ({
    slug: r.slug,
    label: r.label,
    role: r.is_owner ? 'owner' : 'member',
    balance: Number(r.balance),
    // le propriétaire n'a pas de plafond : plafond effectif
    monthly_limit: r.is_owner || r.monthly_limit === null ? null : Number(r.monthly_limit),
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

// Sérialise les changements de membres d'une communauté (garde du dernier
// propriétaire) par un verrou consultatif de transaction : aucun droit UPDATE
// sur community pour le rôle de l'API.
const lockCommunity = (db, communityId) =>
  db.query("SELECT pg_advisory_xact_lock(hashtextextended('webpool:community:' || $1, 0))", [communityId]);

// Communauté dont `clientId` est propriétaire ; sinon introuvable (son existence
// n'est pas révélée aux autres).
async function ownedCommunity(db, { clientId, community }) {
  const { rows } = await db.query(
    `SELECT c.id FROM community c
       JOIN community_standing st ON st.community_id = c.id AND st.api_client_id = $2 AND st.is_owner
      WHERE c.slug = $1`,
    [community, clientId],
  );
  if (rows.length === 0) throw new BillingError('not_found', `Communauté inconnue ou réservée à ses propriétaires : ${community}`);
  return Number(rows[0].id);
}

// Membres, du propriétaire au plus petit apport : rôle calculé, fondateur,
// plafond, dépense sur 30 jours, apports au pot commun.
export async function listMembers({ clientId, community }) {
  const communityId = await ownedCommunity({ query }, { clientId, community });
  const { rows } = await query(
    `SELECT ac.name, st.is_owner, cm.role = 'owner' AS founder, cm.monthly_limit, cm.joined_at,
            ac.revoked_at IS NOT NULL AS revoked, cm.accepted_at IS NOT NULL AS accepted,
            greatest(0, -coalesce((SELECT sum(e.delta) FROM wallet_entry e JOIN wallet w ON w.id = e.wallet_id
                                    WHERE w.community_id = cm.community_id AND e.api_client_id = cm.api_client_id
                                      AND e.kind IN ('debit', 'refund') AND e.created_at > now() - interval '30 days'), 0))::bigint AS spent_30d,
            st.contributed
       FROM community_member cm JOIN api_client ac ON ac.id = cm.api_client_id
       JOIN community_standing st ON st.community_id = cm.community_id AND st.api_client_id = cm.api_client_id
      WHERE cm.community_id = $1
      ORDER BY st.is_owner DESC, st.contributed DESC, ac.name`,
    [communityId],
  );
  return rows.map((r) => ({
    name: r.name,
    role: r.is_owner ? 'owner' : 'member',
    founder: r.founder,
    monthly_limit: r.monthly_limit === null ? null : Number(r.monthly_limit),
    spent_30d: Number(r.spent_30d),
    contributed: Number(r.contributed),
    revoked: r.revoked,
    accepted: r.accepted,
    joined_at: r.joined_at,
  }));
}

// Après un départ ou un retrait : s'il reste des membres actifs, l'un d'eux
// doit être propriétaire (plus gros apport, ou fondateur si personne n'a
// versé). Sinon la transaction est annulée.
async function assertOwnerRemains(db, communityId) {
  const { rows } = await db.query(
    `SELECT bool_or(active) AS members, bool_or(is_owner) AS owner FROM community_standing WHERE community_id = $1`,
    [communityId],
  );
  if (rows[0].members && !rows[0].owner) {
    throw new BillingError('invalid', "La communauté n'aurait plus de propriétaire : un autre membre doit d'abord verser au pot");
  }
}

async function isOwner(db, communityId, name) {
  const { rows } = await db.query(
    `SELECT st.is_owner FROM community_standing st JOIN api_client ac ON ac.id = st.api_client_id
      WHERE st.community_id = $1 AND ac.name = $2`,
    [communityId, name],
  );
  return rows[0]?.is_owner === true;
}

// Invite un client ou change le plafond d'un membre, par un propriétaire
// (upsert partiel). Le rôle ne se donne pas : le propriétaire est celui qui a
// versé le plus au pot. Un nouveau membre reste invité tant qu'il n'a pas
// accepté (POST /communities/{slug}/invitation).
export async function ownerSetMember({ clientId, community, name, role, monthlyLimit }) {
  if (role !== undefined) {
    throw new BillingError('invalid', 'Le rôle ne se donne pas : le propriétaire est le membre qui a versé le plus de giri au pot');
  }
  checkMemberFields(undefined, monthlyLimit);
  return withTransaction(async (db) => {
    const communityId = await ownedCommunity(db, { clientId, community });
    // Sérialise les changements de rôle : la garde du dernier propriétaire reste juste.
    await lockCommunity(db, communityId);
    const { rows } = await db.query('SELECT id FROM api_client WHERE name = $1 AND revoked_at IS NULL', [name]);
    if (rows.length === 0) throw new BillingError('not_found', `Client inconnu ou révoqué : ${name}`);
    // Un client ajouté par un propriétaire est invité : il n'entre qu'en acceptant.
    const { rows: set } = await db.query(
      UPSERT_MEMBER,
      upsertParams({ communityId, clientId: rows[0].id, role: undefined, monthlyLimit, accept: false }),
    );
    const m = memberRow(set[0]);
    const owner = await isOwner(db, communityId, name);
    return { community, name, role: owner ? 'owner' : 'member', monthly_limit: m.monthlyLimit, accepted: m.accepted };
  });
}

export async function ownerRemoveMember({ clientId, community, name }) {
  return withTransaction(async (db) => {
    const communityId = await ownedCommunity(db, { clientId, community });
    await lockCommunity(db, communityId);
    // Un propriétaire l'est par ses apports : un autre propriétaire ne l'écarte
    // pas. Il peut partir lui-même (DELETE …/membership).
    if (await isOwner(db, communityId, name)) {
      throw new BillingError('invalid', `${name} est propriétaire (plus gros apport au pot) : seul lui peut quitter la communauté`);
    }
    const { rowCount } = await db.query(
      `DELETE FROM community_member WHERE community_id = $1
          AND api_client_id = (SELECT id FROM api_client WHERE name = $2)`,
      [communityId, name],
    );
    if (rowCount === 0) throw new BillingError('not_found', `${name} n'est pas membre de ${community}`);
    await assertOwnerRemains(db, communityId);
    return { community, name };
  });
}

// --- Invitations, côté client invité

export async function invitationsFor(clientId) {
  const { rows } = await query(
    `SELECT c.slug, c.label, cm.role, cm.monthly_limit, cm.joined_at
       FROM community_member cm JOIN community c ON c.id = cm.community_id
      WHERE cm.api_client_id = $1 AND cm.accepted_at IS NULL
      ORDER BY cm.joined_at, c.slug`,
    [clientId],
  );
  return rows.map((r) => ({
    slug: r.slug,
    label: r.label,
    role: r.role,
    monthly_limit: r.monthly_limit === null ? null : Number(r.monthly_limit),
    invited_at: r.joined_at,
  }));
}

// Accepte (`accept`) ou décline une invitation ; décliner la supprime.
export async function answerInvitation({ clientId, community, accept }) {
  const { rows } = await query(
    accept
      ? `UPDATE community_member cm SET accepted_at = now() FROM community c
          WHERE c.id = cm.community_id AND c.slug = $1 AND cm.api_client_id = $2 AND cm.accepted_at IS NULL
          RETURNING cm.role`
      : `DELETE FROM community_member cm USING community c
          WHERE c.id = cm.community_id AND c.slug = $1 AND cm.api_client_id = $2 AND cm.accepted_at IS NULL
          RETURNING cm.role`,
    [community, clientId],
  );
  if (rows.length === 0) throw new BillingError('not_found', `Aucune invitation de ${community}`);
  return { community, accepted: accept };
}

// Quitter une communauté (membre actif).
export async function leaveCommunity({ clientId, community }) {
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT c.id FROM community c JOIN community_member cm ON cm.community_id = c.id AND cm.api_client_id = $2
        WHERE c.slug = $1 AND cm.accepted_at IS NOT NULL`,
      [community, clientId],
    );
    if (rows.length === 0) throw new BillingError('not_found', `Communauté inconnue : ${community}`);
    await lockCommunity(db, rows[0].id);
    await db.query('DELETE FROM community_member WHERE community_id = $1 AND api_client_id = $2', [rows[0].id, clientId]);
    // Le propriétaire qui part passe la main au plus gros apport suivant ; s'il
    // n'y en a pas (personne d'autre n'a versé, pas de fondateur), il reste.
    await assertOwnerRemains(db, rows[0].id);
    return { community, left: true };
  });
}
