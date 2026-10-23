#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { closePool, query } from '../src/db.js';
import { ingest } from '../src/ingest/index.js';
import { normalizePending } from '../src/normalize/index.js';
import { classifyPending } from '../src/classify/index.js';
import fs from 'node:fs';
import { createPool, refreshPool, listPools, showPool, loadPoolForExport } from '../src/pools/index.js';
import { formatPool } from '../src/pools/export.js';

const HELP = `webpool — pipeline d'URLs : ingestion, normalisation, classification, pools

Usage :
  webpool ingest --query "…" [--provider file|brave|searxng|europeana|flickr] [--input results.json] [--limit N]
  webpool normalize [--limit N] [--offline]
  webpool classify [--limit N] [--all]
  webpool pool create --slug <slug> [--label "…"] --file definition.json
  webpool pool refresh --slug <slug>
  webpool pool show --slug <slug>
  webpool pool export --slug <slug> [--format json|csv|md] [--out fichier]
  webpool pool list
  webpool stats
`;

const OPTIONS = {
  query: { type: 'string' },
  provider: { type: 'string', default: 'file' },
  input: { type: 'string' },
  limit: { type: 'string' },
  offline: { type: 'boolean', default: false },
  all: { type: 'boolean', default: false },
  slug: { type: 'string' },
  label: { type: 'string' },
  file: { type: 'string' },
  format: { type: 'string', default: 'json' },
  out: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
};

async function stats() {
  const { rows: byStatus } = await query(
    'SELECT status, count(*)::int AS n FROM url_item GROUP BY status ORDER BY status',
  );
  const { rows: runs } = await query(
    `SELECT kind, status, count(*)::int AS n FROM processing_run GROUP BY kind, status ORDER BY kind`,
  );
  return { url_item: byStatus, processing_run: runs };
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: OPTIONS,
    allowPositionals: true,
  });
  const [command, subcommand] = positionals;
  const limit = values.limit ? Number(values.limit) : undefined;

  if (values.help || !command) {
    console.log(HELP);
    return;
  }

  switch (command) {
    case 'ingest': {
      const res = await ingest({
        provider: values.provider,
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
        await createPool({ slug: values.slug, label: values.label, definitionFile: values.file });
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
    case 'stats': {
      const s = await stats();
      console.log(JSON.stringify(s, null, 2));
      break;
    }
    default:
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
