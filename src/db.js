import pg from 'pg';
import { config } from './config.js';

let pool = null;

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
  }
  return pool;
}

export async function query(text, values = []) {
  return getPool().query(text, values);
}

export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // un ROLLBACK qui échoue (connexion perdue) ne masque pas l'erreur d'origine
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
