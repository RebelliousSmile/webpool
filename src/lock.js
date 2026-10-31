import { getPool } from './db.js';

// Verrou consultatif du pipeline : `cycle` et `requests run` normalisent et
// classent la même file `pending` ; jamais en même temps. Tenu sur une
// connexion dédiée, rendue à la fin.
export const PIPELINE_LOCK = 7_765_726_571;

// `wait` : attend que l'autre libère (cycle hebdomadaire, qui ne doit pas sauter) ;
// sinon renvoie null tout de suite si le verrou est pris (requests run, relancé
// tous les quarts d'heure).
export async function withPipelineLock(fn, { wait = false } = {}) {
  const client = await getPool().connect();
  try {
    if (wait) {
      await client.query('SELECT pg_advisory_lock($1)', [PIPELINE_LOCK]);
    } else {
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [PIPELINE_LOCK]);
      if (!rows[0].ok) return null;
    }
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [PIPELINE_LOCK]).catch(() => {});
    }
  } finally {
    client.release();
  }
}
