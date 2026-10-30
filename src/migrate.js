import fs from 'node:fs';
import path from 'node:path';
import { rootDir } from './env.js';

// Runner de migrations. N'importe ni db.js ni config.js : l'appelant fournit le
// client (CLI : un client du pool ; tests : le client admin du schéma jetable).
//
// Règle : une migration par changement de schéma, `NNN_description.sql`, jamais
// modifiée une fois publiée. Chaque fichier s'exécute dans sa propre transaction
// avec l'enregistrement de sa version : il est appliqué en entier ou pas du tout.

const FILE_RE = /^(\d{3})_[\w-]+\.sql$/;
// Clé arbitraire, propre à webpool : deux `migrate` concurrents s'attendent.
const LOCK_KEY = 7_265_301;
const BASELINE = '001';

export async function migrate({ client, dir = path.join(rootDir, 'db', 'migrations') }) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .sort();

  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migration (
         version    TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query('SELECT version FROM schema_migration');
    const applied = new Set(rows.map((r) => r.version));

    // Base créée par l'ancien db/init (avant les migrations) : 001 est déjà en
    // place, on l'enregistre sans la rejouer.
    let baseline = false;
    if (applied.size === 0) {
      const { rows: found } = await client.query("SELECT to_regclass('url_item') IS NOT NULL AS present");
      if (found[0].present) {
        await client.query('INSERT INTO schema_migration (version) VALUES ($1)', [BASELINE]);
        applied.add(BASELINE);
        baseline = true;
      }
    }

    const done = [];
    for (const file of files) {
      const version = file.match(FILE_RE)[1];
      if (applied.has(version)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migration (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${file} en échec : ${err.message}`, { cause: err });
      }
      done.push(file);
    }
    return { applied: done, baseline };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
  }
}
