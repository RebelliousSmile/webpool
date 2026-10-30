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
const FILES = fs.readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
const ALL = FILES.map((f) => f.slice(0, 3));
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
      expect(await migrate({ client: c })).toEqual({ applied: FILES, baseline: false });
      expect(await exists(c, 'url_item')).toBe(true);
      expect(await exists(c, 'pool_item')).toBe(true);
      expect(await versions(c)).toEqual(ALL);

      expect(await migrate({ client: c })).toEqual({ applied: [], baseline: false });
      expect(await versions(c)).toEqual(ALL);
    });
  });

  it('une base de l’ancien db/init passe en baseline et garde ses données', async () => {
    await withSchemaClient(async (c) => {
      await c.query(fs.readFileSync(new URL('001_init.sql', MIGRATIONS), 'utf8'));
      await c.query("INSERT INTO url_item (raw_url) VALUES ('https://a.com/x')");

      expect(await migrate({ client: c })).toEqual({ applied: FILES.slice(1), baseline: true });
      expect(await versions(c)).toEqual(ALL);
      expect((await c.query('SELECT raw_url FROM url_item')).rows).toEqual([{ raw_url: 'https://a.com/x' }]);
    });
  });

  it('002 remplit le registre depuis les URLs normalisées, première découverte comprise', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpool-mig-'));
    fs.copyFileSync(new URL('001_init.sql', MIGRATIONS), path.join(dir, '001_init.sql'));
    await withSchemaClient(async (c) => {
      await migrate({ client: c, dir });
      await c.query(`INSERT INTO url_item (raw_url, domain, canonical_url, status) VALUES
        ('https://a.com/1', 'a.com', 'https://a.com/1', 'classified'),
        ('https://a.com/2', 'a.com', 'https://a.com/2', 'normalized'),
        ('https://b.com/1', NULL, NULL, 'pending')`);
      await c.query(`INSERT INTO url_source (url_item_id, provider, query, discovered_at) VALUES
        (2, 'file', 'tardive', '2026-02-01'), (1, 'file', 'première', '2026-01-01')`);

      fs.copyFileSync(new URL('002_domain_profile.sql', MIGRATIONS), path.join(dir, '002_domain_profile.sql'));
      await migrate({ client: c, dir });
      const { rows } = await c.query('SELECT domain, first_query, usage_commercial FROM domain_profile');
      expect(rows).toEqual([{ domain: 'a.com', first_query: 'première', usage_commercial: null }]);
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
        expect(results.flatMap((r) => r.applied)).toEqual(FILES);
        expect(await versions(a)).toEqual(ALL);
      }),
    );
  });
});
