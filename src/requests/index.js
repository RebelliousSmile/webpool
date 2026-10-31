// Recherches payantes : un client achète `pages` appels à un provider pour une
// requête, payés d'avance sur son portefeuille ou sur celui d'une communauté.
// L'API inscrit la recherche et débite ; `webpool requests run` (tâche
// planifiée) l'exécute, rembourse ce qui n'a pas été appelé, puis normalise,
// classe et rafraîchit les pools visés.
import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import { withPipelineLock } from '../lock.js';
import { withRun } from '../run.js';
import { ingest } from '../ingest/index.js';
import { exclusionFor, loadSaturated } from '../explore/index.js';
import { drain } from '../cycle/index.js';
import { normalizePending } from '../normalize/index.js';
import { classifyPending } from '../classify/index.js';
import { cacheMedia } from '../media/index.js';
import { refreshPool } from '../pools/index.js';
import { BillingError, currentPrices, ensureWallet, postEntry, spentLast30Days } from '../billing/index.js';
import { callCostUsd, checkRequest, parseCallCosts } from '../billing/pricing.js';

export const REQUEST_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'];

const REQUEST_COLUMNS = `sr.id, sr.provider, sr.query, sr.pages, sr.unit_price, sr.price, sr.refunded, sr.status,
  sr.calls_done, sr.results, sr.new_urls, sr.new_domains, sr.in_pool, sr.error,
  sr.created_at, sr.started_at, sr.finished_at, ac.name AS client, p.slug AS pool, c.slug AS community`;
const REQUEST_FROM = `search_request sr
  JOIN api_client ac ON ac.id = sr.api_client_id
  JOIN wallet w ON w.id = sr.wallet_id
  LEFT JOIN community c ON c.id = w.community_id
  LEFT JOIN pool p ON p.id = sr.pool_id`;

const iso = (d) => (d ? new Date(d).toISOString() : null);
export function formatRequest(r) {
  return {
    id: Number(r.id),
    client: r.client,
    provider: r.provider,
    query: r.query,
    pages: r.pages,
    pool: r.pool,
    community: r.community,
    unit_price: Number(r.unit_price),
    price: Number(r.price),
    refunded: Number(r.refunded),
    status: r.status,
    calls_done: r.calls_done,
    results: r.results,
    new_urls: r.new_urls,
    new_domains: r.new_domains,
    in_pool: r.in_pool,
    error: r.error,
    created_at: iso(r.created_at),
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at),
  };
}

async function loadRequest(db, id) {
  const { rows } = await db.query(`SELECT ${REQUEST_COLUMNS} FROM ${REQUEST_FROM} WHERE sr.id = $1`, [id]);
  return formatRequest(rows[0]);
}

// Pool visible par le client : admin, pool public, accord direct, ou pool d'une de ses communautés.
async function visiblePoolId(db, { clientId, isAdmin, slug }) {
  const { rows } = await db.query(
    `SELECT p.id FROM pool p
      WHERE p.slug = $1
        AND ($2 OR p.public
             OR EXISTS (SELECT 1 FROM api_client_pool cp WHERE cp.pool_id = p.id AND cp.api_client_id = $3)
             OR EXISTS (SELECT 1 FROM community_pool cp JOIN community_member cm ON cm.community_id = cp.community_id
                         WHERE cp.pool_id = p.id AND cm.api_client_id = $3))`,
    [slug, isAdmin, clientId],
  );
  if (rows.length === 0) throw new BillingError('not_found', `Pool inconnu : ${slug}`);
  return Number(rows[0].id);
}

// Inscrit une recherche et la paie, en une transaction. Sur le portefeuille
// d'une communauté, la recherche vise un de ses pools et respecte le plafond
// du membre ; un pool d'une communauté du client se paie toujours par elle.
export async function createRequest({
  clientId,
  isAdmin = false,
  provider,
  query: text,
  pages,
  pool,
  community,
  prices = currentPrices(),
  maxQueued = config.requestMaxQueued,
}) {
  let checked;
  try {
    checked = checkRequest({ provider, query: text, pages }, prices);
  } catch (err) {
    throw new BillingError('invalid', err.message);
  }
  const price = checked.unitPrice * checked.pages;

  return withTransaction(async (db) => {
    // Sérialise les achats d'un même client : le compte des recherches en attente reste juste.
    const { rows: me } = await db.query('SELECT id FROM api_client WHERE id = $1 AND revoked_at IS NULL FOR UPDATE', [clientId]);
    if (me.length === 0) throw new BillingError('not_found', 'Client inconnu ou révoqué');
    const { rows: queued } = await db.query(
      `SELECT count(*)::int AS n FROM search_request WHERE api_client_id = $1 AND status IN ('queued', 'running')`,
      [clientId],
    );
    if (queued[0].n >= maxQueued) {
      throw new BillingError('too_many_queued', `${maxQueued} recherches au plus en attente : attendre leur exécution`);
    }

    const poolId = pool ? await visiblePoolId(db, { clientId, isAdmin, slug: pool }) : null;
    // Dans une communauté, on ne paie pas pour soi : une recherche sur un pool
    // d'une de ses communautés se paie sur le pot commun, jamais en personnel.
    if (poolId !== null && !community) {
      const { rows: payers } = await db.query(
        `SELECT c.slug FROM community_pool cp
           JOIN community c ON c.id = cp.community_id
           JOIN community_member cm ON cm.community_id = c.id AND cm.api_client_id = $2
          WHERE cp.pool_id = $1 ORDER BY c.slug`,
        [poolId, clientId],
      );
      if (payers.length > 1) {
        throw new BillingError('invalid', `Pool de plusieurs de vos communautés : préciser laquelle paie (${payers.map((r) => r.slug).join(', ')})`);
      }
      if (payers.length === 1) community = payers[0].slug;
    }
    let wallet;
    let member = null;
    if (community) {
      const { rows } = await db.query(
        `SELECT c.id, cm.monthly_limit FROM community c
           JOIN community_member cm ON cm.community_id = c.id AND cm.api_client_id = $2
          WHERE c.slug = $1`,
        [community, clientId],
      );
      if (rows.length === 0) throw new BillingError('not_found', `Communauté inconnue : ${community}`);
      member = { communityId: Number(rows[0].id), limit: rows[0].monthly_limit === null ? null : Number(rows[0].monthly_limit) };
      if (poolId === null) throw new BillingError('invalid', 'pool requis : le portefeuille de la communauté paie les recherches de ses pools');
      const { rows: owned } = await db.query('SELECT 1 FROM community_pool WHERE community_id = $1 AND pool_id = $2', [member.communityId, poolId]);
      if (owned.length === 0) throw new BillingError('invalid', `Le pool ${pool} n'appartient pas à la communauté ${community}`);
      wallet = await ensureWallet(db, { communityId: member.communityId });
    } else {
      wallet = await ensureWallet(db, { clientId });
    }
    await db.query('SELECT 1 FROM wallet WHERE id = $1 FOR UPDATE', [wallet.id]);

    if (member?.limit !== null && member?.limit !== undefined) {
      const spent = await spentLast30Days(db, { walletId: wallet.id, clientId });
      if (spent + price > member.limit) {
        throw new BillingError(
          'spend_limit',
          `Plafond du membre atteint : ${spent} giri dépensés sur ${member.limit} en 30 jours, cette recherche en coûte ${price}`,
        );
      }
    }

    const { rows } = await db.query(
      `INSERT INTO search_request (api_client_id, wallet_id, pool_id, provider, query, pages, unit_price, price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [clientId, wallet.id, poolId, checked.provider, checked.query, checked.pages, checked.unitPrice, price],
    );
    const id = Number(rows[0].id);
    const balance = await postEntry(db, { walletId: wallet.id, delta: -price, kind: 'debit', requestId: id, clientId });
    if (balance === null) {
      throw new BillingError('insufficient_balance', `Solde insuffisant : ${price} giri nécessaires, ${wallet.balance} disponibles`);
    }
    return { request: await loadRequest(db, id), balance };
  });
}

// Remboursement de ce qui reste dû, dans la transaction `db`.
async function refundRemainder(db, r, note) {
  const due = Number(r.price) - r.calls_done * Number(r.unit_price) - Number(r.refunded);
  if (due <= 0) return 0;
  await postEntry(db, { walletId: r.wallet_id, delta: due, kind: 'refund', requestId: r.id, clientId: r.api_client_id, note });
  await db.query('UPDATE search_request SET refunded = refunded + $2 WHERE id = $1', [r.id, due]);
  return due;
}

// Annule une recherche encore en attente, remboursée en entier. L'auteur ou un admin.
export async function cancelRequest({ id, clientId = null, isAdmin = false }) {
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      'SELECT * FROM search_request WHERE id = $1 AND ($2 OR api_client_id = $3) FOR UPDATE',
      [id, isAdmin, clientId],
    );
    if (rows.length === 0) throw new BillingError('not_found', `Recherche inconnue : ${id}`);
    if (rows[0].status !== 'queued') throw new BillingError('invalid', `Recherche ${id} déjà ${rows[0].status} : seule une recherche en attente s'annule`);
    const refunded = await refundRemainder(db, rows[0], 'annulée');
    await db.query(`UPDATE search_request SET status = 'cancelled', finished_at = now() WHERE id = $1`, [id]);
    return { request: await loadRequest(db, id), refunded };
  });
}

// Recherches d'un client (`clientId`), d'une communauté (`communityId`, pour ses
// propriétaires) ou toutes (admin : ni l'un ni l'autre).
export async function listRequests({ clientId, communityId, status, limit = 50, offset = 0 } = {}) {
  const where = [];
  const values = [];
  const $ = (v) => `$${values.push(v)}`;
  if (clientId !== undefined) where.push(`sr.api_client_id = ${$(clientId)}`);
  if (communityId !== undefined) where.push(`w.community_id = ${$(communityId)}`);
  if (status) where.push(`sr.status = ${$(status)}`);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [{ rows }, { rows: count }] = await Promise.all([
    query(`SELECT ${REQUEST_COLUMNS} FROM ${REQUEST_FROM} ${clause} ORDER BY sr.id DESC LIMIT ${$(limit)} OFFSET ${$(offset)}`, values),
    query(`SELECT count(*)::int AS n FROM ${REQUEST_FROM} ${clause}`, values.slice(0, values.length - 2)),
  ]);
  return { items: rows.map(formatRequest), total: count[0].n };
}

// Une recherche restée `running` (processus interrompu) est close : les appels
// faits restent dus, le reste est remboursé.
async function recoverStale(staleMinutes) {
  const { rows } = await query(
    `SELECT id FROM search_request WHERE status = 'running' AND started_at < now() - make_interval(mins => $1)`,
    [staleMinutes],
  );
  for (const { id } of rows) {
    await withTransaction(async (db) => {
      const { rows: [r] } = await db.query(`SELECT * FROM search_request WHERE id = $1 AND status = 'running' FOR UPDATE`, [id]);
      if (!r) return;
      await refundRemainder(db, r, 'interrompue');
      await db.query(
        `UPDATE search_request SET status = CASE WHEN calls_done > 0 THEN 'done' ELSE 'failed' END,
                error = coalesce(error, 'exécution interrompue'), finished_at = now() WHERE id = $1`,
        [id],
      );
    });
  }
  return rows.length;
}

async function claim(limit) {
  const { rows } = await query(
    `UPDATE search_request SET status = 'running', started_at = now()
      WHERE id IN (SELECT id FROM search_request WHERE status = 'queued' ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [limit],
  );
  return rows.sort((a, b) => Number(a.id) - Number(b.id));
}

// Exécute une recherche page après page ; s'arrête au premier échec ou à la
// première page vide. Chaque appel est enregistré aussitôt.
async function execute(r, { saturated, ingestImpl, estimate, maxChars }) {
  let error = null;
  for (let page = 0; page < r.pages; page += 1) {
    const exclusion = exclusionFor(r.provider, r.query, saturated, maxChars);
    let res;
    try {
      res = await ingestImpl({
        provider: r.provider,
        searchQuery: r.query,
        sentQuery: exclusion.sentQuery,
        excludeDomains: exclusion.excludeDomains,
        page,
        requestId: Number(r.id),
      });
    } catch (err) {
      error = String(err.message ?? err).slice(0, 500);
      break;
    }
    await query(
      `UPDATE search_request SET calls_done = calls_done + 1, results = results + $2, new_urls = new_urls + $3,
              new_domains = new_domains + $4, cost_usd = cost_usd + $5 WHERE id = $1`,
      [r.id, res.total, res.inserted, res.newDomains, res.costUsd ?? estimate(r.provider)],
    );
    r.calls_done += 1;
    if (res.total === 0) break;
  }
  return withTransaction(async (db) => {
    const { rows: [fresh] } = await db.query('SELECT * FROM search_request WHERE id = $1 FOR UPDATE', [r.id]);
    const refunded = await refundRemainder(db, fresh, error ? 'appel en échec' : 'pages non lancées');
    await db.query(
      `UPDATE search_request SET status = $2, error = $3, finished_at = now() WHERE id = $1`,
      [r.id, fresh.calls_done > 0 ? 'done' : 'failed', error],
    );
    return { id: Number(r.id), calls: fresh.calls_done, newUrls: fresh.new_urls, refunded, error, poolId: r.pool_id };
  });
}

// Tâche planifiée : exécute jusqu'à `limit` recherches en attente, puis traite
// leurs URLs et rafraîchit les pools visés. null si un autre `requests run`
// ou un `cycle` tient le verrou du pipeline.
export async function runRequests({
  limit = 10,
  offline = false,
  staleMinutes = 60,
  batch = 100,
  ingestImpl = ingest,
  cfg = config,
} = {}) {
  return withPipelineLock(async () => {
    const recovered = await recoverStale(staleMinutes);
    const claimed = await claim(limit);
    if (claimed.length === 0) return { recovered, requests: [], pools: [] };

    const overrides = parseCallCosts(cfg.callCostsUsd);
    const estimate = (provider) => callCostUsd(provider, { engine: cfg.openrouterEngine, overrides });
    return withRun('request', { requests: claimed.map((r) => Number(r.id)) }, async () => {
      const saturated = await loadSaturated(cfg.exploreSaturation);
      const done = [];
      for (const r of claimed) {
        done.push(await execute(r, { saturated, ingestImpl, estimate, maxChars: cfg.exploreQueryMaxChars }));
      }

      await drain(async (n) => {
        const res = await normalizePending({ limit: n, offline });
        return { ...res, processed: res.total };
      }, batch);
      await drain(async (n) => {
        const res = await classifyPending({ limit: n });
        return { ...res, processed: res.classified };
      }, batch);
      // Une vignette manquante ne doit pas priver les pools de leur refresh.
      if (!offline) {
        await drain(async (n) => {
          const res = await cacheMedia({ limit: n });
          return { ...res, processed: res.total };
        }, batch).catch(() => {});
      }

      const poolIds = [...new Set(done.map((d) => d.poolId).filter((id) => id !== null))];
      const pools = [];
      for (const id of poolIds) {
        const { rows } = await query('SELECT slug FROM pool WHERE id = $1', [id]);
        if (!rows[0]) continue;
        try {
          pools.push({ slug: rows[0].slug, count: (await refreshPool(rows[0].slug)).count });
        } catch (err) {
          pools.push({ slug: rows[0].slug, error: String(err.message ?? err) });
        }
      }
      // URLs de chaque recherche présentes dans le pool qu'elle vise.
      await query(
        `UPDATE search_request sr
            SET in_pool = (SELECT count(DISTINCT pi.url_item_id)::int FROM pool_item pi
                             JOIN url_source us ON us.url_item_id = pi.url_item_id AND us.search_request_id = sr.id
                            WHERE pi.pool_id = sr.pool_id)
          WHERE sr.id = ANY($1) AND sr.pool_id IS NOT NULL`,
        [done.map((d) => d.id)],
      );
      return { recovered, requests: done, pools };
    });
  });
}
