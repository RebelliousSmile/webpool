import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
// Jamais src/config.js ici : ce module est importé par setup.js avant que DATABASE_URL
// ne pointe sur le schéma jetable, et figerait config.databaseUrl sur le schéma réel.
import { defaultDatabaseUrl, loadDotEnv } from '../../src/env.js';
import { migrate } from '../../src/migrate.js';

loadDotEnv();
// URL d'origine, mémorisée avant que setup.js ne redirige DATABASE_URL vers le schéma jetable.
process.env.WEBPOOL_IT_BASE_URL ??= process.env.DATABASE_URL ?? defaultDatabaseUrl();
process.env.WEBPOOL_IT_SCHEMA ??= `webpool_it_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const BASE_URL = process.env.WEBPOOL_IT_BASE_URL;
export const SCHEMA = process.env.WEBPOOL_IT_SCHEMA;

export function schemaUrl() {
  const url = new URL(BASE_URL);
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  return url.toString();
}

async function withAdminClient(fn) {
  const client = new pg.Client({ connectionString: BASE_URL, connectionTimeoutMillis: 2000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// En CI (ou WEBPOOL_IT_REQUIRED défini), une base injoignable fait échouer la suite.
export function dbRequired(env = process.env) {
  return Boolean(env.CI || env.WEBPOOL_IT_REQUIRED);
}

export async function dbAvailable() {
  try {
    await withAdminClient((c) => c.query('SELECT 1'));
    return true;
  } catch {
    return false;
  }
}

// Schéma jetable migré par le runner, comme une base réelle. `migrate: false`
// le laisse vide (tests du runner lui-même).
export async function createSchema({ migrate: runMigrations = true } = {}) {
  await withAdminClient(async (c) => {
    await c.query(`CREATE SCHEMA ${SCHEMA}`);
    await c.query(`SET search_path TO ${SCHEMA}`);
    if (runMigrations) await migrate({ client: c });
  });
}

// Client admin dont le search_path vise le schéma jetable.
export async function withSchemaClient(fn) {
  return withAdminClient(async (c) => {
    await c.query(`SET search_path TO ${SCHEMA}`);
    return fn(c);
  });
}

export async function dropSchema() {
  await withAdminClient((c) => c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`));
}

// Remise à zéro entre les tests (schéma conservé, séquences réinitialisées).
export async function resetData(query) {
  const { rows } = await query('SELECT current_schema() AS schema');
  if (rows[0]?.schema !== SCHEMA) {
    throw new Error(`resetData refusé : schéma courant "${rows[0]?.schema}", attendu "${SCHEMA}"`);
  }
  await query(
    `TRUNCATE pool_item, pool, url_facet_value, facet_definition, url_theme, theme,
              url_source, url_item, processing_run, domain_profile, search_query_run, search_query, explore_pipe,
              api_client_pool, api_client, community, community_member, community_pool,
              wallet, wallet_entry, search_request RESTART IDENTITY CASCADE`,
  );
}

export function writeTempJson(name, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpool-it-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}
