import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

const DEFAULT_URL = 'postgres://webpool:webpool@localhost:5432/webpool';
// URL d'origine, mémorisée avant que setup.js ne redirige DATABASE_URL vers le schéma jetable.
process.env.WEBPOOL_IT_BASE_URL ??= process.env.DATABASE_URL ?? DEFAULT_URL;
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

export async function dbAvailable() {
  try {
    await withAdminClient((c) => c.query('SELECT 1'));
    return true;
  } catch {
    return false;
  }
}

export async function createSchema() {
  const sql = fs.readFileSync(new URL('../../db/init/001_init.sql', import.meta.url), 'utf8');
  await withAdminClient(async (c) => {
    await c.query(`CREATE SCHEMA ${SCHEMA}`);
    await c.query(`SET search_path TO ${SCHEMA}`);
    await c.query(sql);
  });
}

export async function dropSchema() {
  await withAdminClient((c) => c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`));
}

// Remise à zéro entre les tests (schéma conservé, séquences réinitialisées).
export async function resetData(query) {
  await query(
    `TRUNCATE pool_item, pool, url_facet_value, facet_definition, url_theme, theme,
              url_source, url_item, processing_run RESTART IDENTITY CASCADE`,
  );
}

export function writeTempJson(name, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpool-it-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}
