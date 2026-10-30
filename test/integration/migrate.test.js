import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/migrate.js';
import { createSchema, dbAvailable, dbRequired, dropSchema, withSchemaClient } from './helpers.js';

const available = await dbAvailable();
if (!available && dbRequired()) {
  throw new Error('[integration] PostgreSQL injoignable alors que la suite est requise (CI ou WEBPOOL_IT_REQUIRED).');
}

const MIGRATIONS = new URL('../../db/migrations/', import.meta.url);
const versions = async (c) => (await c.query('SELECT version FROM schema_migration ORDER BY version')).rows.map((r) => r.version);
const exists = async (c, table) => (await c.query('SELECT to_regclass($1) IS NOT NULL AS ok', [table])).rows[0].ok;

describe.skipIf(!available)('migrate', () => {
  beforeEach(async () => {
    await dropSchema();
    await createSchema({ migrate: false });
  });

  afterAll(async () => {
    await dropSchema();
  });

  it('crée le schéma sur une base vide, puis un rejeu n’applique rien', async () => {
    await withSchemaClient(async (c) => {
      expect(await migrate({ client: c })).toEqual({ applied: ['001_init.sql'], baseline: false });
      expect(await exists(c, 'url_item')).toBe(true);
      expect(await exists(c, 'pool_item')).toBe(true);
      expect(await versions(c)).toEqual(['001']);

      expect(await migrate({ client: c })).toEqual({ applied: [], baseline: false });
      expect(await versions(c)).toEqual(['001']);
    });
  });

  it('une base de l’ancien db/init passe en baseline et garde ses données', async () => {
    await withSchemaClient(async (c) => {
      await c.query(fs.readFileSync(new URL('001_init.sql', MIGRATIONS), 'utf8'));
      await c.query("INSERT INTO url_item (raw_url) VALUES ('https://a.com/x')");

      expect(await migrate({ client: c })).toEqual({ applied: [], baseline: true });
      expect(await versions(c)).toEqual(['001']);
      expect((await c.query('SELECT raw_url FROM url_item')).rows).toEqual([{ raw_url: 'https://a.com/x' }]);
    });
  });

  it('une migration en erreur n’est ni appliquée ni enregistrée, et l’erreur nomme le fichier', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpool-mig-'));
    fs.copyFileSync(new URL('001_init.sql', MIGRATIONS), path.join(dir, '001_init.sql'));
    fs.writeFileSync(
      path.join(dir, '002_casse.sql'),
      'CREATE TABLE partielle (id int);\nSELECT * FROM table_absente;\n',
    );
    await withSchemaClient(async (c) => {
      await expect(migrate({ client: c, dir })).rejects.toThrow(/Migration 002_casse\.sql en échec/);
      expect(await versions(c)).toEqual(['001']);
      expect(await exists(c, 'url_item')).toBe(true);
      expect(await exists(c, 'partielle')).toBe(false);
    });
  });

  it('deux migrate concurrents ne se chevauchent pas', async () => {
    await withSchemaClient((a) =>
      withSchemaClient(async (b) => {
        const results = await Promise.all([migrate({ client: a }), migrate({ client: b })]);
        expect(results.flatMap((r) => r.applied)).toEqual(['001_init.sql']);
        expect(await versions(a)).toEqual(['001']);
      }),
    );
  });
});
