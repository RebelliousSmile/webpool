#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { closePool, getPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { ingest } from '../src/ingest/index.js';
import { normalizePending } from '../src/normalize/index.js';
import { classifyPending } from '../src/classify/index.js';
import fs from 'node:fs';
import { createPool, refreshPool, listPools, showPool, loadPoolForExport, setPoolPublic } from '../src/pools/index.js';
import { formatPool } from '../src/pools/export.js';
import { stats } from '../src/stats.js';
import { assertUsage, listDomains, qualifyDomain, setExploreExcluded } from '../src/domains/index.js';
import { addQuery, explore, importQueries, listPipes, listQueries, parseTags } from '../src/explore/index.js';
import { cycle } from '../src/cycle/index.js';
import { cacheMedia } from '../src/media/index.js';
import { addClient, listClients, revokeClient, setPoolAccess } from '../src/api/clients.js';
import { config } from '../src/config.js';
import {
  addCommunity, adjust, billingReport, credit, currentPrices, listCommunities, removeMember,
  setCommunityPool, setMember, walletEntries, walletOf,
} from '../src/billing/index.js';
import { eurosOf, parseEuros } from '../src/billing/pricing.js';
import { REQUEST_STATUSES, cancelRequest, listRequests, runRequests } from '../src/requests/index.js';

const HELP = `webpool — pipeline d'URLs : ingestion, normalisation, classification, pools

Usage :
  webpool ingest --query "…" [--provider file|brave|searxng|europeana|flickr] [--input results.json] [--limit N]
  webpool normalize [--limit N] [--offline]
  webpool classify [--limit N] [--all]     (--all : tout le corpus, par lots de N)
  webpool pool create --slug <slug> [--label "…"] --file definition.json [--force]
  webpool pool refresh --slug <slug>
  webpool pool show --slug <slug>
  webpool pool export --slug <slug> [--format json|csv|md|txt] [--out fichier]
  webpool pool list
  webpool pool publish|unpublish --slug <slug>   (pool public : visible par tout client, sans accord)
  webpool domain list [--to-qualify] [--limit N]
  webpool domain set --domain <domaine> --usage libre|sous-conditions|payant|non-commercial [--note "…"]
  webpool domain exclude --domain <domaine>   (écarté des requêtes Brave par -site:, en plus des domaines saturés)
  webpool domain include --domain <domaine>
  webpool query add --provider <p> --query "…" [--tags a,b]
  webpool query import --file requetes.json      (liste de {provider, query, tags} ; ajoute les étiquettes manquantes aux requêtes connues)
  webpool query list [--status active|exhausted|paused]
  webpool pipe list                        (tuyaux flot:<slug> : requêtes actives, pression et référence de la dernière visite)
  webpool explore --budget N [--provider p] [--limit N]   (au plus N appels aux providers, ceux du tuyau courant d'abord)
  webpool media [--limit N] [--retry-failed]   (vignettes et favicons en attente : téléchargés, réduits en WebP, mis en cache)
  webpool cycle --budget N [--provider p] [--offline]   (explore, normalize, classify et media jusqu'à vider la file, refresh des pools)
  webpool serve [--port N] [--host h]   (API HTTP, voir openapi.json)
  webpool client add --name <nom> [--scope admin|read]   (affiche le jeton une seule fois)
  webpool client list
  webpool client revoke --name <nom>
  webpool client grant --name <nom> --slug <pool>   (client read : accès au pool)
  webpool client ungrant --name <nom> --slug <pool>
  webpool community add --slug <slug> [--label "…"]
  webpool community list
  webpool community join --slug <communauté> --name <client> [--role owner|member] [--monthly N|none]   (plafond en giri sur 30 jours ; option absente : inchangée)
  webpool community leave --slug <communauté> --name <client>
  webpool community attach|detach --slug <communauté> --pool <pool>   (pools visibles par les membres, payables par la communauté)
  webpool wallet credit (--name <client> | --community <slug>) --eur 12,50 --ref <paiement> [--note "…"] [--force]   (don ou achat de giri ; --force sous le minimum)
  webpool wallet adjust (--name <client> | --community <slug>) --giri=±N --note "…"   (ex. --giri=-50)
  webpool wallet show (--name <client> | --community <slug>)
  webpool pricing                          (prix d'un appel par provider, en giri et en €)
  webpool requests run [--limit N] [--offline]   (recherches payées en attente, puis normalize, classify, media, refresh des pools visés)
  webpool requests list [--status queued|running|done|failed|cancelled]
  webpool requests cancel --id N           (recherche en attente, remboursée)
  webpool billing report [--days N]        (giri crédités et dépensés, coût des providers, marge)
  webpool stats
  webpool migrate                         (applique les migrations db/migrations manquantes)
`;

const OPTIONS = {
  query: { type: 'string' },
  provider: { type: 'string' },
  input: { type: 'string' },
  limit: { type: 'string' },
  offline: { type: 'boolean', default: false },
  all: { type: 'boolean', default: false },
  'retry-failed': { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  slug: { type: 'string' },
  label: { type: 'string' },
  file: { type: 'string' },
  format: { type: 'string', default: 'json' },
  out: { type: 'string' },
  domain: { type: 'string' },
  usage: { type: 'string' },
  note: { type: 'string' },
  'to-qualify': { type: 'boolean', default: false },
  tags: { type: 'string' },
  status: { type: 'string' },
  budget: { type: 'string' },
  name: { type: 'string' },
  scope: { type: 'string', default: 'read' },
  port: { type: 'string' },
  host: { type: 'string' },
  community: { type: 'string' },
  pool: { type: 'string' },
  role: { type: 'string' },
  monthly: { type: 'string' },
  eur: { type: 'string' },
  ref: { type: 'string' },
  giri: { type: 'string' },
  id: { type: 'string' },
  days: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
};

const giriEur = (giri) => `${eurosOf(giri, config.giriPerEur).toFixed(3).replace('.', ',')} €`;
const walletOwner = (values) => ({ name: values.name, community: values.community });

// Valide avant toute connexion à la base.
function parsePositive(name, raw) {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || n <= 0) throw new Error(`--${name} doit être un entier > 0 (reçu : "${raw}")`);
  return n;
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: OPTIONS,
    allowPositionals: true,
  });
  const [command, subcommand] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return;
  }
  const limit = parsePositive('limit', values.limit);

  switch (command) {
    case 'ingest': {
      const res = await ingest({
        provider: values.provider ?? 'file',
        searchQuery: values.query,
        input: values.input,
        limit,
      });
      console.log(
        `Ingest run #${res.runId} : ${res.total} résultats, ${res.inserted} nouvelles URLs, ${res.existing} déjà connues.`,
      );
      break;
    }
    case 'normalize': {
      const res = await normalizePending({ limit, offline: values.offline });
      console.log(
        `Normalize run #${res.runId} : ${res.normalized} normalisées, ${res.duplicate} doublons, ${res.error} erreurs (sur ${res.total}).`,
      );
      break;
    }
    case 'classify': {
      const res = await classifyPending({ limit, reclassify: values.all });
      console.log(
        `Classify run #${res.runId} : ${res.classified} classées, dont ${res.unthemed} sans thème.`,
      );
      break;
    }
    case 'pool': {
      if (subcommand === 'create') {
        if (!values.slug || !values.file) throw new Error('pool create : --slug et --file requis');
        await createPool({ slug: values.slug, label: values.label, definitionFile: values.file, force: values.force });
        const res = await refreshPool(values.slug);
        console.log(`Pool "${values.slug}" créé et matérialisé : ${res.count} URLs.`);
      } else if (subcommand === 'refresh') {
        if (!values.slug) throw new Error('pool refresh : --slug requis');
        const res = await refreshPool(values.slug);
        console.log(`Pool "${values.slug}" rematérialisé : ${res.count} URLs.`);
      } else if (subcommand === 'show') {
        if (!values.slug) throw new Error('pool show : --slug requis');
        const rows = await showPool(values.slug);
        for (const r of rows) {
          console.log(`${String(r.rank).padStart(3)}  ${Number(r.score).toFixed(3)}  ${r.canonical_url}`);
        }
        if (rows.length === 0) console.log('(pool vide — lancer pool refresh)');
      } else if (subcommand === 'export') {
        if (!values.slug) throw new Error('pool export : --slug requis');
        const output = formatPool(await loadPoolForExport(values.slug), values.format);
        if (values.out) fs.writeFileSync(values.out, output);
        else process.stdout.write(output);
      } else if (subcommand === 'publish' || subcommand === 'unpublish') {
        if (!values.slug) throw new Error(`pool ${subcommand} : --slug requis`);
        await setPoolPublic(values.slug, subcommand === 'publish');
        console.log(`Pool "${values.slug}" ${subcommand === 'publish' ? 'public : visible par tout client' : 'réservé aux clients autorisés'}.`);
      } else if (subcommand === 'list') {
        const pools = await listPools();
        for (const p of pools) {
          console.log(`${p.slug}  (${p.items} URLs, refresh: ${p.refreshed_at ?? 'jamais'})${p.public ? ' [public]' : ''}  ${p.label}`);
        }
        if (pools.length === 0) console.log('(aucun pool)');
      } else {
        throw new Error(`Sous-commande pool inconnue : ${subcommand ?? '(aucune)'}`);
      }
      break;
    }
    case 'domain': {
      if (subcommand === 'list') {
        const rows = await listDomains({ toQualify: values['to-qualify'], limit });
        for (const d of rows) {
          const seen = d.first_seen_at.toISOString().slice(0, 10);
          console.log(
            `${String(d.urls).padStart(5)}  ${(d.usage_commercial ?? 'à qualifier').padEnd(15)}  ${d.domain}  (vu le ${seen}${d.first_query ? ` par « ${d.first_query} »` : ''})${d.explore_excluded ? '  [exclu]' : ''}`,
          );
        }
        if (rows.length === 0) console.log('(aucun domaine)');
      } else if (subcommand === 'set') {
        if (!values.domain || !values.usage) throw new Error('domain set : --domain et --usage requis');
        assertUsage(values.usage);
        const res = await qualifyDomain({ domain: values.domain, usage: values.usage, note: values.note });
        console.log(
          res.rewritten === null
            ? `Domaine ${res.domain} qualifié « ${res.usage} » ; facette usage-commercial absente de la base (lancer classify) : aucune URL réécrite.`
            : `Domaine ${res.domain} qualifié « ${res.usage} » : ${res.rewritten} URLs mises à jour.`,
        );
      } else if (subcommand === 'exclude' || subcommand === 'include') {
        if (!values.domain) throw new Error(`domain ${subcommand} : --domain requis`);
        const res = await setExploreExcluded({ domain: values.domain, excluded: subcommand === 'exclude' });
        console.log(
          res.excluded
            ? `Domaine ${res.domain} exclu de l'exploration.`
            : `Domaine ${res.domain} réintégré (reste exclu s'il est saturé).`,
        );
      } else {
        throw new Error(`Sous-commande domain inconnue : ${subcommand ?? '(aucune)'}`);
      }
      break;
    }
    case 'query': {
      if (subcommand === 'add') {
        if (!values.provider || !values.query) throw new Error('query add : --provider et --query requis');
        const res = await addQuery({ provider: values.provider, query: values.query, tags: parseTags(values.tags) });
        console.log(`Requête #${res.id} ajoutée (${res.provider}) : « ${res.query} »${res.tags.length ? ` [${res.tags.join(', ')}]` : ''}.`);
      } else if (subcommand === 'import') {
        if (!values.file) throw new Error('query import : --file requis');
        const res = await importQueries(values.file);
        console.log(`Requêtes importées : ${res.added} ajoutées, ${res.updated} étiquetées, ${res.skipped} déjà connues.`);
      } else if (subcommand === 'list') {
        const rows = await listQueries({ status: values.status });
        for (const q of rows) {
          const prio = q.priority === Infinity ? 'neuve' : q.priority.toFixed(2);
          console.log(
            `#${String(q.id).padEnd(4)} ${q.status.padEnd(9)} ${q.provider.padEnd(9)} p.${q.nextPage}  ${String(q.runs).padStart(3)} passages  ${String(q.newDomains).padStart(4)} domaines  prio ${prio}  ${q.query}${q.tags.length ? `  [${q.tags.join(', ')}]` : ''}`,
          );
        }
        if (rows.length === 0) console.log('(aucune requête)');
      } else {
        throw new Error(`Sous-commande query inconnue : ${subcommand ?? '(aucune)'}`);
      }
      break;
    }
    case 'pipe': {
      if (subcommand !== 'list') throw new Error(`Sous-commande pipe inconnue : ${subcommand ?? '(aucune)'}`);
      const rows = await listPipes();
      const fmt = (v) => (v === null ? '—' : v.toFixed(2));
      for (const p of rows) {
        console.log(
          `${p.current ? '*' : ' '} ${p.slug.padEnd(20)} ${String(p.active).padStart(3)} actives  pression ${fmt(p.pressure).padStart(5)}  référence ${fmt(p.reference).padStart(5)}  (${p.judged} appels jugés${p.enteredAt ? ` depuis le ${p.enteredAt.toISOString().slice(0, 16).replace('T', ' ')}` : ''})`,
        );
      }
      if (rows.length === 0) console.log('(aucune requête, donc aucun tuyau)');
      break;
    }
    case 'explore': {
      const budget = parsePositive('budget', values.budget);
      if (budget === undefined) throw new Error('explore : --budget requis');
      const res = await explore({ budget, provider: values.provider, limit });
      for (const q of res.queries) {
        console.log(
          q.error
            ? `  #${q.id} ${q.provider} p.${q.page} : erreur — ${q.error}`
            : `  #${q.id} ${q.servedBy === q.provider ? q.provider : `${q.provider}→${q.servedBy} (repli : ${q.fallbackError})`} p.${q.page}${q.excluded ? ` (-${q.excluded} domaines)` : ''} : ${q.results} résultats, ${q.newUrls} URLs nouvelles, ${q.newDomains} domaines nouveaux${q.exhausted ? ' (épuisée)' : ''}  « ${q.query} »`,
        );
      }
      console.log(
        `Explore run #${res.runId}${res.pipes.length ? ` [${res.pipes.join(' → ')}]` : ''} : ${res.calls} appels, ${res.newUrls} URLs nouvelles, ${res.newDomains} domaines nouveaux, ${res.errors} erreurs${res.woken ? `, ${res.woken} requêtes reposées réactivées` : ''}.`,
      );
      break;
    }
    case 'media': {
      const res = await cacheMedia({ limit, retryFailed: values['retry-failed'] });
      console.log(
        `Media run #${res.runId} : ${res.thumbs} vignettes, ${res.favicons} favicons, ${res.failed} échecs (sur ${res.total}).`,
      );
      break;
    }
    case 'cycle': {
      const budget = parsePositive('budget', values.budget);
      if (budget === undefined) throw new Error('cycle : --budget requis');
      const res = await cycle({ budget, provider: values.provider, offline: values.offline, exploreOptions: { limit } });
      for (const s of res.steps) console.log(`${s.name.padEnd(9)} ${s.ok ? 'ok    ' : 'ÉCHEC '} ${s.line}`);
      if (!res.ok) process.exitCode = 1;
      break;
    }
    case 'serve': {
      const port = parsePositive('port', values.port) ?? config.apiPort;
      // import différé : le serveur n'est chargé que pour cette commande
      const { serve } = await import('../src/api/index.js');
      await serve({ port, host: values.host ?? config.apiHost, corsOrigins: config.apiCorsOrigins });
      break;
    }
    case 'client': {
      if (subcommand === 'add') {
        if (!values.name) throw new Error('client add : --name requis');
        const res = await addClient({ name: values.name, scope: values.scope });
        console.log(`Client "${res.name}" (${res.scope}) créé. Jeton, affiché une seule fois :\n${res.token}`);
      } else if (subcommand === 'list') {
        const rows = await listClients();
        for (const c of rows) {
          const state = c.revoked_at ? `révoqué le ${c.revoked_at.toISOString().slice(0, 10)}` : 'actif';
          console.log(
            `${c.name.padEnd(20)} ${c.scope.padEnd(5)}  ${state}${c.scope === 'read' ? `  pools : ${c.pools.join(', ') || '(aucun)'}` : ''}`,
          );
        }
        if (rows.length === 0) console.log('(aucun client)');
      } else if (subcommand === 'revoke') {
        if (!values.name) throw new Error('client revoke : --name requis');
        await revokeClient({ name: values.name });
        console.log(`Client "${values.name}" révoqué.`);
      } else if (subcommand === 'grant' || subcommand === 'ungrant') {
        if (!values.name || !values.slug) throw new Error(`client ${subcommand} : --name et --slug requis`);
        const granted = subcommand === 'grant';
        await setPoolAccess({ name: values.name, slug: values.slug, granted });
        console.log(`Pool "${values.slug}" ${granted ? 'accordé à' : 'retiré à'} "${values.name}".`);
      } else {
        throw new Error(`Sous-commande client inconnue : ${subcommand ?? '(aucune)'}`);
      }
      break;
    }
    case 'migrate': {
      const client = await getPool().connect();
      try {
        const res = await migrate({ client });
        if (res.baseline) console.log('Base existante : 001 enregistrée comme baseline.');
        console.log(
          res.applied.length
            ? `Migrations appliquées : ${res.applied.join(', ')}.`
            : 'Schéma à jour : aucune migration à appliquer.',
        );
      } finally {
        client.release();
      }
      break;
    }
    case 'community': {
      if (subcommand === 'add') {
        if (!values.slug) throw new Error('community add : --slug requis');
        await addCommunity({ slug: values.slug, label: values.label });
        console.log(`Communauté "${values.slug}" créée.`);
      } else if (subcommand === 'list') {
        const rows = await listCommunities();
        for (const c of rows) {
          console.log(`${c.slug.padEnd(20)} ${String(c.balance).padStart(8)} giri  membres : ${c.members.join(', ') || '(aucun)'}  pools : ${c.pools.join(', ') || '(aucun)'}`);
        }
        if (rows.length === 0) console.log('(aucune communauté)');
      } else if (subcommand === 'join') {
        if (!values.slug || !values.name) throw new Error('community join : --slug et --name requis');
        // --monthly absent : plafond gardé ; « none » : sans plafond ; 0 bloque la dépense
        let monthlyLimit;
        if (values.monthly === 'none') monthlyLimit = null;
        else if (values.monthly !== undefined) {
          if (!/^\d+$/.test(values.monthly)) throw new Error(`--monthly doit être un entier ≥ 0 ou none (reçu : "${values.monthly}")`);
          monthlyLimit = Number(values.monthly);
        }
        const m = await setMember({ community: values.slug, name: values.name, role: values.role, monthlyLimit });
        console.log(`"${values.name}" membre (${m.role}) de "${values.slug}", ${m.monthlyLimit === null ? 'sans plafond' : `plafond ${m.monthlyLimit} giri / 30 jours`}.`);
      } else if (subcommand === 'leave') {
        if (!values.slug || !values.name) throw new Error('community leave : --slug et --name requis');
        await removeMember({ community: values.slug, name: values.name });
        console.log(`"${values.name}" n'est plus membre de "${values.slug}".`);
      } else if (subcommand === 'attach' || subcommand === 'detach') {
        if (!values.slug || !values.pool) throw new Error(`community ${subcommand} : --slug et --pool requis`);
        await setCommunityPool({ community: values.slug, pool: values.pool, attached: subcommand === 'attach' });
        console.log(`Pool "${values.pool}" ${subcommand === 'attach' ? 'rattaché à' : 'détaché de'} "${values.slug}".`);
      } else {
        throw new Error(`Sous-commande community inconnue : ${subcommand ?? '(aucune)'}`);
      }
      break;
    }
    case 'wallet': {
      if (subcommand === 'credit') {
        if (!values.eur) throw new Error('wallet credit : --eur requis');
        const cents = parseEuros(values.eur);
        const res = await credit({ ...walletOwner(values), cents, reference: values.ref, note: values.note, force: values.force });
        console.log(`${res.kind === 'donation' ? 'Don' : 'Achat'} de ${(cents / 100).toFixed(2).replace('.', ',')} € : +${res.giri} giri, solde ${res.balance} giri.`);
      } else if (subcommand === 'adjust') {
        if (!/^[+-]?\d+$/.test(values.giri ?? '')) throw new Error('wallet adjust : --giri entier requis (ex. --giri=-50)');
        const res = await adjust({ ...walletOwner(values), giri: Number(values.giri), note: values.note });
        console.log(`Correction de ${res.giri} giri, solde ${res.balance} giri.`);
      } else if (subcommand === 'show') {
        const wallet = await walletOf(walletOwner(values));
        console.log(`Solde : ${wallet.balance} giri (${giriEur(wallet.balance)})`);
        const { items } = await walletEntries({ walletId: wallet.id, limit: limit ?? 20 });
        for (const e of items) {
          const sign = e.delta > 0 ? `+${e.delta}` : String(e.delta);
          console.log(`${e.created_at.toISOString().slice(0, 16)}  ${sign.padStart(8)}  ${e.kind.padEnd(10)} ${e.search_request_id ? `#${e.search_request_id} ` : ''}${e.reference ?? ''}${e.client ? ` (${e.client})` : ''}${e.note ? ` — ${e.note}` : ''}`);
        }
      } else {
        throw new Error(`Sous-commande wallet inconnue : ${subcommand ?? '(aucune)'}`);
      }
      break;
    }
    case 'pricing': {
      const prices = currentPrices();
      console.log(`1 € = ${config.giriPerEur} giri ; majoration ×${config.priceMarkup} ; 1 $ = ${config.usdEur} €`);
      for (const p of prices) {
        console.log(`${p.provider.padEnd(12)} ${String(p.unit_price).padStart(5)} giri l'appel (${giriEur(p.unit_price)}, coût ${p.cost_usd} $), ${p.max_pages} page(s) au plus`);
      }
      if (prices.length === 0) console.log('(aucun provider ouvert : WEBPOOL_REQUEST_PROVIDERS)');
      break;
    }
    case 'requests': {
      if (subcommand === 'run') {
        const res = await runRequests({ limit: limit ?? 10, offline: values.offline });
        if (res === null) {
          console.log('Un autre requests run est en cours : rien à faire.');
          break;
        }
        if (res.recovered) console.log(`${res.recovered} recherche(s) interrompue(s) close(s).`);
        for (const r of res.requests) {
          console.log(`#${r.id} : ${r.calls} appel(s), ${r.newUrls} URLs nouvelles${r.refunded ? `, ${r.refunded} giri remboursés` : ''}${r.error ? ` ; erreur : ${r.error}` : ''}`);
        }
        for (const p of res.pools) console.log(`pool ${p.slug} : ${p.error ? `erreur — ${p.error}` : `${p.count} URLs`}`);
        if (res.requests.length === 0) console.log('Aucune recherche en attente.');
        if (res.requests.length > 0 && res.requests.every((r) => r.error)) process.exitCode = 1;
      } else if (subcommand === 'list') {
        const status = values.status;
        if (status && !REQUEST_STATUSES.includes(status)) throw new Error(`--status invalide : ${status} (attendu : ${REQUEST_STATUSES.join(', ')})`);
        const { items } = await listRequests({ status, limit: limit ?? 50 });
        for (const r of items) {
          console.log(`#${String(r.id).padEnd(5)} ${r.status.padEnd(9)} ${r.client.padEnd(16)} ${r.provider.padEnd(10)} ${String(r.price - r.refunded).padStart(5)} giri  ${r.community ? `[${r.community}] ` : ''}${r.pool ? `→ ${r.pool} ` : ''}« ${r.query} »`);
        }
        if (items.length === 0) console.log('(aucune recherche)');
      } else if (subcommand === 'cancel') {
        const id = parsePositive('id', values.id);
        if (!id) throw new Error('requests cancel : --id requis');
        const res = await cancelRequest({ id, isAdmin: true });
        console.log(`Recherche #${id} annulée, ${res.refunded} giri remboursés.`);
      } else {
        throw new Error(`Sous-commande requests inconnue : ${subcommand ?? '(aucune)'}`);
      }
      break;
    }
    case 'billing': {
      if (subcommand !== 'report') throw new Error(`Sous-commande billing inconnue : ${subcommand ?? '(aucune)'}`);
      const days = parsePositive('days', values.days) ?? 30;
      const r = await billingReport({ days });
      console.log(`Sur ${days} jours :`);
      for (const c of r.credits) console.log(`  ${c.kind === 'donation' ? 'dons  ' : 'achats'} : ${c.entries}, ${c.eur.toFixed(2)} €, ${c.giri} giri`);
      if (r.credits.length === 0) console.log('  aucun crédit');
      console.log(`  encours : ${r.outstanding.personal} giri personnels, ${r.outstanding.communities} giri de communautés (${r.outstanding.eur.toFixed(2)} €)`);
      for (const p of r.providers) {
        console.log(`  ${p.provider.padEnd(10)} ${p.requests} recherches, ${p.calls} appels, ${p.giri} giri (${p.revenue_eur.toFixed(2)} €), coût ${p.cost_usd.toFixed(4)} $, marge ${p.margin_eur.toFixed(2)} €`);
      }
      break;
    }
    case 'stats': {
      const s = await stats();
      console.log(JSON.stringify(s, null, 2));
      break;
    }
    default:
      console.error(`Commande inconnue : ${command}
`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(`Erreur : ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
