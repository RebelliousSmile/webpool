// Recherches payantes : un client achète `pages` appels à un provider pour une
// requête, payés d'avance sur son portefeuille personnel ou sur le pot d'une
// communauté. L'API inscrit la recherche et débite ; `webpool requests run`
// (tâche planifiée) l'exécute, rembourse ce qui n'a pas été appelé, puis
// normalise, classe et rafraîchit les pools visés.
import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import { withPipelineLock } from '../lock.js';
import { withRun } from '../run.js';
import { poolGrantedSql } from '../access.js';
import { ingest } from '../ingest/index.js';
import { exclusionFor, loadSaturated } from '../explore/index.js';
import { processPending, refreshPools } from '../pipeline/index.js';
import { BillingError, currentPrices, ensureWallet, postEntry, spentLast30Days } from '../billing/index.js';
import { LIST_PROVIDER, callCostUsd, checkLinkList, checkRequest, parseCallCosts } from '../billing/pricing.js';

export const REQUEST_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'];
const STATUS_LABELS = { queued: 'en attente', running: 'en cours', done: 'faite', failed: 'en échec', cancelled: 'annulée' };

// Clé d'idempotence d'un achat (en-tête Idempotency-Key).
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,100}$/;

// Erreurs exposées aux clients : jamais le message brut d'un provider (clés,
// crédit du fournisseur…), qui reste visible de l'admin.
export const PUBLIC_ERRORS = {
  provider: "le fournisseur de recherche n'a pas répondu ; appels non faits remboursés",
  interrupted: 'exécution interrompue ; appels non faits remboursés',
  internal: 'erreur interne ; appels non faits remboursés',
};

// `in_pool` se calcule à la lecture : URLs de la recherche présentes aujourd'hui
// dans le pool qu'elle vise.
const REQUEST_COLUMNS = `sr.id, sr.provider, sr.query, sr.pages, sr.unit_price, sr.price, sr.refunded, sr.status,
  sr.calls_done, sr.results, sr.new_urls, sr.new_domains, sr.error, sr.error_kind, sr.rewarded,
  CASE WHEN sr.links IS NULL THEN NULL ELSE jsonb_array_length(sr.links) END AS links_count,
  CASE WHEN sr.pool_id IS NULL THEN NULL ELSE
    (SELECT count(DISTINCT pi.url_item_id)::int FROM pool_item pi
       JOIN url_source us ON us.url_item_id = pi.url_item_id AND us.search_request_id = sr.id
      WHERE pi.pool_id = sr.pool_id) END AS in_pool,
  sr.created_at, sr.started_at, sr.finished_at, ac.name AS client, p.slug AS pool, c.slug AS community`;
const REQUEST_FROM = `search_request sr
  JOIN api_client ac ON ac.id = sr.api_client_id
  JOIN wallet w ON w.id = sr.wallet_id
  LEFT JOIN community c ON c.id = w.community_id
  LEFT JOIN pool p ON p.id = sr.pool_id`;

const iso = (d) => (d ? new Date(d).toISOString() : null);

// `admin` : message d'erreur brut ; sinon le message public de sa catégorie.
export function formatRequest(r, { admin = false } = {}) {
  return {
    id: Number(r.id),
    client: r.client,
    provider: r.provider,
    query: r.query,
    pages: r.pages,
    // liste de liens : nombre de liens soumis (null pour une recherche)
    links: r.links_count ?? null,
    pool: r.pool,
    community: r.community,
    unit_price: Number(r.unit_price),
    price: Number(r.price),
    refunded: Number(r.refunded),
    // giri gagnés par les liens valides de la liste
    rewarded: Number(r.rewarded ?? 0),
    status: r.status,
    calls_done: r.calls_done,
    results: r.results,
    new_urls: r.new_urls,
    new_domains: r.new_domains,
    in_pool: r.in_pool,
    error: r.error === null ? null : admin ? r.error : (PUBLIC_ERRORS[r.error_kind] ?? PUBLIC_ERRORS.internal),
    created_at: iso(r.created_at),
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at),
  };
}

async function loadRequest(db, id, options) {
  const { rows } = await db.query(`SELECT ${REQUEST_COLUMNS} FROM ${REQUEST_FROM} WHERE sr.id = $1`, [id]);
  return formatRequest(rows[0], options);
}

async function visiblePoolId(db, { clientId, isAdmin, slug }) {
  const { rows } = await db.query(
    `SELECT p.id FROM pool p WHERE p.slug = $1 AND ($2 OR ${poolGrantedSql('p', '$3')})`,
    [slug, isAdmin, clientId],
  );
  if (rows.length === 0) throw new BillingError('not_found', `Pool inconnu : ${slug}`);
  return Number(rows[0].id);
}

// Inscrit une recherche et la paie, en une transaction. Un pool d'une
// communauté du client se paie toujours sur son pot, avec le plafond du
// membre (le propriétaire, plus gros apport, n'en a pas) ; le pot d'une communauté ne paie que ses pools. Avec
// `idempotencyKey`, un second envoi de la même clé rend la recherche déjà
// achetée (`replayed`), sans nouveau débit.
export async function createRequest({
  clientId,
  isAdmin = false,
  provider,
  query: text,
  pages,
  pool,
  community,
  links,
  idempotencyKey = null,
  prices = currentPrices(),
  maxQueued = config.requestMaxQueued,
  listPricing = { perLink: config.listPricePerLink, maxLinks: config.listMaxLinks },
}) {
  if (idempotencyKey !== null && !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    throw new BillingError('invalid', 'Idempotency-Key : 1 à 100 caractères parmi A-Z a-z 0-9 _ -');
  }
  // Une liste de liens (provider `list`) se valide à part : ses liens sont ses
  // résultats, payés d'un bloc. Ensuite, tout est commun avec les recherches.
  const isList = provider === LIST_PROVIDER;
  let checked;
  try {
    if (!isList && links !== undefined) throw new Error('links : réservé au provider list');
    checked = isList ? checkLinkList({ query: text, links }, listPricing) : checkRequest({ provider, query: text, pages }, prices);
  } catch (err) {
    throw new BillingError('invalid', err.message);
  }
  // Un admin (la maison) ne se facture pas : sans communauté désignée, sa
  // soumission est gratuite, pour tout pool, et compte pour include_requests.
  const free = isAdmin && !community;
  const unitPrice = free ? 0 : checked.unitPrice;
  const price = unitPrice * checked.pages;

  return withTransaction(async (db) => {
    // Sérialise les achats d'un même client (file d'attente, idempotence) par
    // un verrou consultatif de transaction : aucun droit UPDATE sur api_client.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('webpool:client:' || $1, 0))", [clientId]);
    const { rows: me } = await db.query('SELECT 1 FROM api_client WHERE id = $1 AND revoked_at IS NULL', [clientId]);
    if (me.length === 0) throw new BillingError('not_found', 'Client inconnu ou révoqué');
    if (idempotencyKey !== null) {
      const { rows: prior } = await db.query(
        'SELECT id, wallet_id FROM search_request WHERE api_client_id = $1 AND idempotency_key = $2',
        [clientId, idempotencyKey],
      );
      if (prior.length) {
        const { rows: w } = await db.query('SELECT balance FROM wallet WHERE id = $1', [prior[0].wallet_id]);
        return { request: await loadRequest(db, prior[0].id), balance: Number(w[0].balance), replayed: true };
      }
    }
    const { rows: queued } = await db.query(
      `SELECT count(*)::int AS n FROM search_request WHERE api_client_id = $1 AND status IN ('queued', 'running')`,
      [clientId],
    );
    if (queued[0].n >= maxQueued) {
      throw new BillingError('too_many_queued', `${maxQueued} recherches au plus en attente : attendre leur exécution`);
    }

    const poolId = pool ? await visiblePoolId(db, { clientId, isAdmin, slug: pool }) : null;
    let payer = community;
    // Dans une communauté, on ne paie pas pour soi : une recherche sur un pool
    // d'une de ses communautés se paie sur le pot commun, jamais en personnel.
    if (poolId !== null && !payer && !free) {
      const { rows: payers } = await db.query(
        `SELECT c.slug FROM community_pool cp
           JOIN community c ON c.id = cp.community_id
           JOIN community_member cm ON cm.community_id = c.id AND cm.api_client_id = $2 AND cm.accepted_at IS NOT NULL
          WHERE cp.pool_id = $1 ORDER BY c.slug`,
        [poolId, clientId],
      );
      if (payers.length > 1) {
        throw new BillingError('invalid', `Pool de plusieurs de vos communautés : préciser laquelle paie (${payers.map((r) => r.slug).join(', ')})`);
      }
      if (payers.length === 1) payer = payers[0].slug;
    }
    // Une liste n'entre que dans un pool de communauté, payée par son pot :
    // jamais d'injection sur un portefeuille personnel.
    if (isList && !payer && !free) {
      throw new BillingError('invalid', "Liste de liens : réservée aux pools d'une de vos communautés (pool requis)");
    }
    let wallet;
    let member = null;
    if (payer) {
      const { rows } = await db.query(
        `SELECT c.id, CASE WHEN st.is_owner THEN NULL ELSE cm.monthly_limit END AS monthly_limit FROM community c
           JOIN community_member cm ON cm.community_id = c.id AND cm.api_client_id = $2 AND cm.accepted_at IS NOT NULL
           JOIN community_standing st ON st.community_id = c.id AND st.api_client_id = cm.api_client_id
          WHERE c.slug = $1`,
        [payer, clientId],
      );
      if (rows.length === 0) throw new BillingError('not_found', `Communauté inconnue : ${payer}`);
      member = { communityId: Number(rows[0].id), limit: rows[0].monthly_limit === null ? null : Number(rows[0].monthly_limit) };
      if (poolId === null) throw new BillingError('invalid', 'pool requis : le pot de la communauté paie les recherches de ses pools');
      const { rows: owned } = await db.query('SELECT 1 FROM community_pool WHERE community_id = $1 AND pool_id = $2', [member.communityId, poolId]);
      if (owned.length === 0) throw new BillingError('invalid', `Le pool ${pool} n'appartient pas à la communauté ${payer}`);
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
      `INSERT INTO search_request (api_client_id, wallet_id, pool_id, provider, query, pages, unit_price, price, idempotency_key, links)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [clientId, wallet.id, poolId, checked.provider, checked.query, checked.pages, unitPrice, price, idempotencyKey,
        isList ? JSON.stringify(checked.links) : null],
    );
    const id = Number(rows[0].id);
    // Gratuit : aucune écriture au grand livre.
    const balance = price === 0 ? wallet.balance : await postEntry(db, { walletId: wallet.id, delta: -price, kind: 'debit', requestId: id, clientId });
    if (balance === null) {
      throw new BillingError('insufficient_balance', `Solde insuffisant : ${price} giri nécessaires, ${wallet.balance} disponibles`);
    }
    return { request: await loadRequest(db, id), balance, replayed: false };
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
    if (rows[0].status !== 'queued') {
      throw new BillingError('invalid', `Recherche ${id} déjà ${STATUS_LABELS[rows[0].status]} : seule une recherche en attente s'annule`);
    }
    const refunded = await refundRemainder(db, rows[0], 'annulée');
    await db.query(
      `UPDATE search_request SET status = 'cancelled', finished_at = now(), processed_at = now() WHERE id = $1`,
      [id],
    );
    return { request: await loadRequest(db, id, { admin: isAdmin }), refunded };
  });
}

// Recherches d'un client (`clientId`), d'une communauté (`communityId`, pour ses
// propriétaires) ou toutes (admin : ni l'un ni l'autre). `admin` : erreurs brutes.
export async function listRequests({ clientId, communityId, status, limit = 50, offset = 0, admin = false } = {}) {
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
  return { items: rows.map((r) => formatRequest(r, { admin })), total: count[0].n };
}

// Sous le verrou du pipeline, une recherche `running` trouvée au démarrage est
// orpheline (processus interrompu) : close, appels faits dus, reste remboursé.
async function recoverStale(staleMinutes) {
  const { rows } = await query(
    `SELECT id FROM search_request WHERE status = 'running' AND started_at <= now() - make_interval(mins => $1)`,
    [staleMinutes],
  );
  for (const { id } of rows) {
    await withTransaction(async (db) => {
      const { rows: [r] } = await db.query(`SELECT * FROM search_request WHERE id = $1 AND status = 'running' FOR UPDATE`, [id]);
      if (!r) return;
      await refundRemainder(db, r, 'interrompue');
      await db.query(
        `UPDATE search_request SET status = CASE WHEN calls_done > 0 THEN 'done' ELSE 'failed' END,
                error = coalesce(error, 'exécution interrompue'), error_kind = coalesce(error_kind, 'interrupted'),
                finished_at = now() WHERE id = $1`,
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

// Rend à la file des recherches réservées mais jamais lancées.
async function requeue(ids) {
  if (ids.length) {
    await query(`UPDATE search_request SET status = 'queued', started_at = NULL WHERE id = ANY($1) AND calls_done = 0`, [ids]);
  }
}

// Exécute une recherche page après page ; s'arrête au premier échec ou à la
// première page vide. Chaque appel est enregistré aussitôt. Un échec du
// provider est remboursé ; un échec d'écriture après un appel facturé aussi,
// mais son coût estimé reste compté.
async function execute(r, { saturated, ingestImpl, estimate, maxChars }) {
  let error = null;
  let errorKind = null;
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
        // liste de liens : ses liens sont ses résultats
        ...(r.provider === LIST_PROVIDER ? { input: r.links } : {}),
      });
    } catch (err) {
      error = String(err.message ?? err).slice(0, 500);
      errorKind = err.providerFailed ? 'provider' : 'internal';
      if (!err.providerFailed) {
        await query('UPDATE search_request SET cost_usd = cost_usd + $2 WHERE id = $1', [r.id, estimate(r.provider)]);
      }
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
    const done = fresh.calls_done > 0;
    await db.query(
      `UPDATE search_request SET status = $2, error = $3, error_kind = $4, finished_at = now(),
              processed_at = CASE WHEN $2 = 'failed' THEN now() END
        WHERE id = $1`,
      [r.id, done ? 'done' : 'failed', error, errorKind],
    );
    return { id: Number(r.id), calls: fresh.calls_done, newUrls: fresh.new_urls, refunded, error };
  });
}

// Post-traitement des recherches faites et pas encore traitées, celles de ce
// run comme celles qu'un run précédent n'a pas pu finir : normalize et classify
// de leurs URLs, puis refresh de leurs pools. Marquées traitées seulement si
// tout a réussi ; sinon reprises au run suivant.
async function postProcess({ offline, batch, rewardRules }) {
  const { rows: pending } = await query(
    `SELECT sr.id, p.slug AS pool FROM search_request sr LEFT JOIN pool p ON p.id = sr.pool_id
      WHERE sr.status = 'done' AND sr.processed_at IS NULL ORDER BY sr.id`,
  );
  if (pending.length === 0) return { requests: [], steps: [], pools: [] };
  const requestIds = pending.map((r) => Number(r.id));
  const { rows: urls } = await query(
    'SELECT DISTINCT url_item_id AS id FROM url_source WHERE search_request_id = ANY($1)',
    [requestIds],
  );
  const steps = await processPending({ offline, batch, ids: urls.map((u) => Number(u.id)), mediaBatches: 1 });
  const slugs = [...new Set(pending.map((r) => r.pool).filter(Boolean))];
  const poolStep = await refreshPools(slugs);
  steps.push(poolStep);
  // Les médias ne conditionnent pas la reprise : une vignette manquante n'empêche
  // pas les liens d'être dans le pool.
  const ok = steps.filter((s) => s.name !== 'media').every((s) => s.ok) && (poolStep.result?.failures ?? 1) === 0;
  // Récompenses et marque « traité » ensemble : une reprise ne récompense pas deux fois.
  let rewards = [];
  if (ok) {
    rewards = await withTransaction(async (db) => {
      const granted = await grantRewards(db, requestIds, rewardRules);
      await db.query('UPDATE search_request SET processed_at = now() WHERE id = ANY($1)', [requestIds]);
      return granted;
    });
  }
  return { requests: requestIds, steps, pools: poolStep.result?.items ?? [], ok, rewards };
}

// Tâche planifiée : exécute jusqu'à `limit` recherches en attente, puis
// post-traite toutes les recherches faites non traitées. null si un autre
// `requests run` ou un `cycle` tient le verrou du pipeline.
export async function runRequests({
  limit = 10,
  offline = false,
  staleMinutes = 0,
  batch = 100,
  ingestImpl = ingest,
  cfg = config,
} = {}) {
  return withPipelineLock(async () => {
    const recovered = await recoverStale(staleMinutes);
    const claimed = await claim(limit);
    const overrides = parseCallCosts(cfg.callCostsUsd);
    const estimate = (provider) => callCostUsd(provider, { engine: cfg.openrouterEngine, overrides });

    const done = [];
    if (claimed.length) {
      await withRun('request', { requests: claimed.map((r) => Number(r.id)) }, async () => {
        let saturated;
        try {
          saturated = await loadSaturated(cfg.exploreSaturation);
        } catch (err) {
          // Rien n'a été appelé : les recherches retournent dans la file.
          await requeue(claimed.map((r) => Number(r.id)));
          throw err;
        }
        for (const r of claimed) {
          done.push(await execute(r, { saturated, ingestImpl, estimate, maxChars: cfg.exploreQueryMaxChars }));
        }
        return { executed: done.length };
      });
    }
    const rewardRules = { perLink: cfg.linkReward, domainCap: cfg.linkRewardDomainCap, monthlyCap: cfg.linkRewardMonthlyCap };
    const post = await postProcess({ offline, batch, rewardRules });
    return {
      recovered, requests: done, processed: post.requests, steps: post.steps, pools: post.pools, ok: post.ok ?? true, rewards: post.rewards ?? [],
    };
  });
}

// --- Récompense des liens valides

// Liens valides des listes `requestIds`, dans l'ordre de soumission : liste
// payée par une communauté (pas l'admin), lien classé, hors quarantaine, dans
// le pool visé, nouveau pour le corpus au moment de la soumission, jamais
// récompensé. Plafonds sur 30 jours par membre (`monthlyCap` giri) et par
// membre et domaine (`domainCap` liens). Les giri vont sur le portefeuille
// personnel du membre (écriture `reward`), une écriture par liste.
async function grantRewards(db, requestIds, { perLink, domainCap, monthlyCap }) {
  if (perLink <= 0 || requestIds.length === 0) return [];
  const { rows: candidates } = await db.query(
    `SELECT sr.id AS request_id, sr.api_client_id AS client_id, ui.id AS url_item_id, ui.domain
       FROM search_request sr
       JOIN wallet w ON w.id = sr.wallet_id AND w.community_id IS NOT NULL
       JOIN api_client ac ON ac.id = sr.api_client_id AND ac.scope <> 'admin'
       JOIN url_source us ON us.search_request_id = sr.id
       JOIN url_item ui ON ui.id = us.url_item_id
       JOIN pool_item pi ON pi.pool_id = sr.pool_id AND pi.url_item_id = ui.id
      WHERE sr.id = ANY($1) AND sr.provider = $2
        AND ui.status = 'classified' AND ui.quarantined_at IS NULL
        AND ui.first_seen_at >= sr.created_at
        AND NOT EXISTS (SELECT 1 FROM link_reward lr WHERE lr.url_item_id = ui.id)
      ORDER BY sr.id, us.serp_rank, us.id`,
    [requestIds, LIST_PROVIDER],
  );
  const used = new Map(); // client → { giri, domains: Map(domain → liens) } sur 30 jours
  const usage = async (clientId) => {
    if (!used.has(clientId)) {
      const { rows } = await db.query(
        `SELECT domain, count(*)::int AS n, sum(giri)::bigint AS giri FROM link_reward
          WHERE api_client_id = $1 AND created_at > now() - interval '30 days' GROUP BY domain`,
        [clientId],
      );
      used.set(clientId, {
        giri: rows.reduce((t, r) => t + Number(r.giri), 0),
        domains: new Map(rows.map((r) => [r.domain, r.n])),
      });
    }
    return used.get(clientId);
  };
  const perRequest = new Map();
  const seenItems = new Set();
  for (const c of candidates) {
    if (seenItems.has(c.url_item_id)) continue;
    const u = await usage(c.client_id);
    if (u.giri + perLink > monthlyCap || (u.domains.get(c.domain) ?? 0) >= domainCap) continue;
    seenItems.add(c.url_item_id);
    u.giri += perLink;
    u.domains.set(c.domain, (u.domains.get(c.domain) ?? 0) + 1);
    await db.query(
      `INSERT INTO link_reward (url_item_id, search_request_id, api_client_id, domain, giri) VALUES ($1, $2, $3, $4, $5)`,
      [c.url_item_id, c.request_id, c.client_id, c.domain, perLink],
    );
    const r = perRequest.get(c.request_id) ?? { clientId: c.client_id, links: 0 };
    r.links += 1;
    perRequest.set(c.request_id, r);
  }
  const granted = [];
  for (const [requestId, r] of perRequest) {
    const giri = r.links * perLink;
    const wallet = await ensureWallet(db, { clientId: r.clientId });
    await postEntry(db, {
      walletId: wallet.id, delta: giri, kind: 'reward', requestId, clientId: r.clientId,
      note: `${r.links} lien${r.links > 1 ? 's' : ''} valide${r.links > 1 ? 's' : ''} apporté${r.links > 1 ? 's' : ''}`,
    });
    await db.query('UPDATE search_request SET rewarded = rewarded + $2 WHERE id = $1', [requestId, giri]);
    granted.push({ id: Number(requestId), links: r.links, giri });
  }
  return granted;
}

// --- Compte rendu lien par lien d'une recherche ou d'une liste

// Catégorie d'une erreur de normalisation, exposée aux clients (le message
// brut reste réservé à l'admin).
export function errorCategory({ error, http_status: httpStatus }) {
  if (httpStatus === 404 || httpStatus === 410) return 'not_found';
  if (/hôte refusé/i.test(error ?? '')) return 'host_refused';
  if (httpStatus && httpStatus >= 400) return 'http_error';
  return 'network';
}

// Sort de chaque lien : position (ordre de soumission, ou rang dans les
// résultats), URL soumise, URL canonique, état. Visible de l'auteur, des
// propriétaires de la communauté qui a payé, et de l'admin.
export async function requestLinks({ id, clientId, isAdmin = false }) {
  const { rows: req } = await query(
    `SELECT sr.id, sr.links, sr.pool_id, sr.created_at, sr.status FROM search_request sr
       JOIN wallet w ON w.id = sr.wallet_id
      WHERE sr.id = $1
        AND ($2 OR sr.api_client_id = $3
             OR EXISTS (SELECT 1 FROM community_standing st
                         WHERE st.community_id = w.community_id AND st.api_client_id = $3 AND st.is_owner))`,
    [id, isAdmin, clientId],
  );
  if (req.length === 0) throw new BillingError('not_found', `Recherche inconnue : ${id}`);
  const r = req[0];
  const { rows } = await query(
    `SELECT us.serp_rank AS position, ui.raw_url, ui.canonical_url, ui.domain, ui.title, ui.status, ui.error, ui.http_status,
            ui.first_seen_at < $2 AS known, ui.quarantined_at IS NOT NULL AS quarantined,
            EXISTS (SELECT 1 FROM pool_item pi WHERE pi.pool_id = $3 AND pi.url_item_id = ui.id) AS in_pool,
            (SELECT lr.giri FROM link_reward lr WHERE lr.url_item_id = ui.id AND lr.search_request_id = $1) AS reward
       FROM url_source us JOIN url_item ui ON ui.id = us.url_item_id
      WHERE us.search_request_id = $1
      ORDER BY us.serp_rank NULLS LAST, us.id`,
    [id, r.created_at, r.pool_id],
  );
  const submitted = Array.isArray(r.links) ? r.links : null;
  const items = rows.map((row) => {
    // Lien mis en quarantaine par le contrôle des liens (lien mort) : erreur.
    const outcome =
      row.status === 'error' || row.quarantined ? 'error'
        : row.status === 'classified' ? (r.pool_id === null ? 'in_corpus' : row.in_pool ? 'in_pool' : 'not_in_pool')
          : 'examining';
    return {
      position: row.position,
      url: submitted?.[row.position - 1]?.url ?? row.raw_url,
      canonical_url: row.canonical_url,
      domain: row.domain,
      title: row.title,
      outcome,
      known: row.known,
      reward: row.reward === null || row.reward === undefined ? 0 : Number(row.reward),
      error_category: outcome === 'error' ? (row.quarantined && row.status !== 'error' ? 'quarantined' : errorCategory(row)) : null,
      ...(isAdmin ? { error: row.error, http_status: row.http_status } : {}),
    };
  });
  // Liste pas encore ingérée : ses liens, en attente.
  if (items.length === 0 && submitted) {
    return submitted.map((l, i) => ({
      position: i + 1, url: l.url, canonical_url: null, domain: null, title: l.title, outcome: 'queued', known: false, reward: 0, error_category: null,
    }));
  }
  return items;
}
