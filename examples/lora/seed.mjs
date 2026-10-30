#!/usr/bin/env node
// Jeu de démonstration « entraînement LoRA » : rejoue tout le pipeline du CLI sur
// des exports SERP figés (provider file), sans réseau ni clé d'API.
//   ingest (5 requêtes) → normalize --offline → classify → 5 pools → affichage
//
// Usage : node examples/lora/seed.mjs [--remote]
// La base est celle du CLI (DATABASE_URL, sinon le conteneur local). Le jeu ajoute
// des URLs au corpus : hors localhost, --remote est exigé pour ne pas polluer une
// base partagée par mégarde.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { defaultDatabaseUrl, loadDotEnv, rootDir } from '../../src/env.js';

const here = join(rootDir, 'examples', 'lora');
const remoteAllowed = process.argv.includes('--remote');

loadDotEnv();
const { hostname } = new URL(process.env.DATABASE_URL || defaultDatabaseUrl());
if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname) && !remoteAllowed) {
  console.error(`Base distante (${hostname}) : relancer avec --remote pour y verser le jeu LoRA.`);
  process.exit(1);
}

function webpool(...args) {
  const out = execFileSync(process.execPath, [join(rootDir, 'bin', 'webpool.js'), ...args], { encoding: 'utf8' }).trim();
  if (out) console.log(out);
}

const list = (dir) => readdirSync(join(here, dir)).filter((f) => f.endsWith('.json')).sort();

console.log('## Ingestion');
for (const file of list('serp')) {
  const path = join(here, 'serp', file);
  const { query } = JSON.parse(readFileSync(path, 'utf8'));
  process.stdout.write(`« ${query} » — `);
  webpool('ingest', '--provider', 'file', '--query', query, '--input', path);
}

console.log('\n## Normalisation et classification');
webpool('normalize', '--offline');
webpool('classify');

console.log('\n## Pools');
for (const file of list('pools')) {
  webpool('pool', 'create', '--slug', basename(file, '.json'), '--file', join(here, 'pools', file), '--force');
}

for (const file of list('pools')) {
  console.log(`\n### ${basename(file, '.json')}`);
  webpool('pool', 'show', '--slug', basename(file, '.json'));
}
