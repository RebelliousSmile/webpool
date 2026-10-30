#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { closePool, getPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { ingest } from '../src/ingest/index.js';
import { normalizePending } from '../src/normalize/index.js';
import { classifyPending } from '../src/classify/index.js';
import fs from 'node:fs';
import { createPool, refreshPool, listPools, showPool, loadPoolForExport } from '../src/pools/index.js';
import { formatPool } from '../src/pools/export.js';
import { stats } from '../src/stats.js';
import { assertUsage, listDomains, qualifyDomain, setExploreExcluded } from '../src/domains/index.js';
import { addQuery, explore, importQueries, listQueries, parseTags } from '../src/explore/index.js';
import { cycle } from '../src/cycle/index.js';

const HELP = `webpool — pipeline d'URLs : ingestion, normalisation, classification, pools

Usage :
  webpool ingest --query "…" [--provider file|brave|searxng|europeana|flickr] [--input results.json] [--limit N]
  webpool normalize [--limit N] [--offline]
  webpool classify [--limit N] [--all]     (--all : tout le corpus, par lots de N)
  webpool pool create --slug <slug> [--label "…"] --file definition.json [--force]
  webpool pool refresh --slug <slug>
  webpool pool show --slug <slug>
  webpool pool export --slug <slug> [--format json|csv|md] [--out fichier]
  webpool pool list
  webpool domain list [--to-qualify] [--limit N]
  webpool domain set --domain <domaine> --usage libre|sous-conditions|payant|non-commercial [--note "…"]
  webpool domain exclude --domain <domaine>   (écarté des requêtes Brave par -site:, en plus des domaines saturés)
  webpool domain include --domain <domaine>
  webpool query add --provider <p> --query "…" [--tags a,b]
  webpool query import --file requetes.json      (liste de {provider, query, tags})
  webpool query list [--status active|exhausted|paused]
  webpool explore --budget N [--provider p] [--limit N]   (au plus N appels aux providers)
  webpool cycle --budget N [--provider p] [--offline]   (explore, normalize et classify jusqu'à vider la file, refresh des pools)
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
  help: { type: 'boolean', short: 'h', default: false },
};

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
      } else if (subcommand === 'list') {
        const pools = await listPools();
        for (const p of pools) {
          console.log(`${p.slug}  (${p.items} URLs, refresh: ${p.refreshed_at ?? 'jamais'})  ${p.label}`);
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
        console.log(`Requêtes importées : ${res.added} ajoutées, ${res.skipped} déjà connues.`);
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
        `Explore run #${res.runId} : ${res.calls} appels, ${res.newUrls} URLs nouvelles, ${res.newDomains} domaines nouveaux, ${res.errors} erreurs${res.woken ? `, ${res.woken} requêtes reposées réactivées` : ''}.`,
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
