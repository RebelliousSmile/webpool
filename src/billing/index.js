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

// Ajoute un membre, ou change son rôle et son plafond s'il l'est déjà.
export async function setMember({ community, name, role = 'member', monthlyLimit = null }) {
  if (!ROLES.includes(role)) throw new BillingError('invalid', `--role invalide : "${role}" (attendu : ${ROLES.join(', ')})`);
  const { clientId, communityId } = await ids({ name, community });
  await query(
    `INSERT INTO community_member (community_id, api_client_id, role, monthly_limit) VALUES ($1, $2, $3, $4)
     ON CONFLICT (community_id, api_client_id) DO UPDATE SET role = EXCLUDED.role, monthly_limit = EXCLUDED.monthly_limit`,
    [communityId, clientId, role, monthlyLimit],
  );
  return { community, name, role, monthlyLimit };
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
    throw new BillingError('invalid', 'Un portefeuille : --name (client) ou --community, pas les deux');
  }
  return ids(name !== undefined ? { name } : { community });
}

// Don (portefeuille d'un client) ou achat (portefeuille d'une communauté),
// saisi par l'admin à réception du paiement. `reference` identifie ce
// paiement : le même n'est jamais crédité deux fois.
export async function credit({ name, community, cents, reference, note = null, giriPerEur = config.giriPerEur }) {
  if (!reference?.trim()) throw new BillingError('invalid', '--ref requis : référence du paiement reçu (ex. liberapay:1234)');
  const giri = giriFromCents(cents, giriPerEur);
  if (giri < 1) throw new BillingError('invalid', 'Montant trop faible pour un giri');
  const { clientId, communityId } = await ownerIds({ name, community });
  return withTransaction(async (db) => {
    const { rows: dup } = await db.query('SELECT 1 FROM wallet_entry WHERE reference = $1', [reference.trim()]);
    if (dup.length) throw new BillingError('invalid', `Paiement déjà crédité : ${reference.trim()}`);
    const wallet = await ensureWallet(db, { clientId, communityId });
    const balance = await postEntry(db, {
      walletId: wallet.id,
      delta: giri,
      kind: clientId !== null ? 'donation' : 'purchase',
      amountCents: cents,
      reference: reference.trim(),
      note,
    });
    return { giri, balance, kind: clientId !== null ? 'donation' : 'purchase' };
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
  const { rows } = await query(
    `SELECT c.id AS community_id, c.slug, c.label, cm.role, cm.monthly_limit, w.id AS wallet_id, coalesce(w.balance, 0) AS balance,
            (SELECT coalesce(array_agg(p.slug ORDER BY p.slug), '{}')
               FROM community_pool cp JOIN pool p ON p.id = cp.pool_id WHERE cp.community_id = c.id) AS pools
       FROM community_member cm
       JOIN community c ON c.id = cm.community_id
       LEFT JOIN wallet w ON w.community_id = c.id
      WHERE cm.api_client_id = $1
      ORDER BY c.slug`,
    [clientId],
  );
  const communities = [];
  for (const r of rows) {
    const spent = r.wallet_id === null ? 0 : await spentLast30Days({ query }, { walletId: r.wallet_id, clientId });
    communities.push({
      slug: r.slug,
      label: r.label,
      role: r.role,
      balance: Number(r.balance),
      monthly_limit: r.monthly_limit === null ? null : Number(r.monthly_limit),
      spent_30d: spent,
      pools: r.pools,
    });
  }
  return { personal: { balance: personal.balance }, communities };
}

// Recettes et dépenses sur `days` jours : giri crédités (et €), giri dépensés
// net des remboursements, coût des providers, par provider.
export async function billingReport({ days = 30, usdEur = config.usdEur, giriPerEur = config.giriPerEur } = {}) {
  const [{ rows: credits }, { rows: byProvider }] = await Promise.all([
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
  return {
    days,
    credits: credits.map((c) => ({ kind: c.kind, entries: c.entries, giri: Number(c.giri), eur: Number(c.cents) / 100 })),
    providers: providersOut,
  };
}
