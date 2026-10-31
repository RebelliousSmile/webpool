import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSchema, dbAvailable, dbRequired, dropSchema, resetData, schemaUrl } from './helpers.js';

const exec = promisify(execFile);
const available = await dbAvailable();
if (!available && dbRequired()) {
  throw new Error('[integration] PostgreSQL injoignable alors que la suite est requise (CI ou WEBPOOL_IT_REQUIRED).');
}

const BIN = fileURLToPath(new URL('../../bin/webpool.js', import.meta.url));

// Le CLI des recherches payantes, lancé comme en production (processus séparé)
// sur le schéma jetable : sorties, validations et codes de sortie.
describe.skipIf(!available)('CLI : communautés, portefeuilles, recherches', () => {
  let db;
  const cli = async (...args) => {
    try {
      const { stdout } = await exec(process.execPath, [BIN, ...args], {
        env: { ...process.env, DATABASE_URL: schemaUrl(), BRAVE_API_KEY: '', WEBPOOL_REQUEST_PROVIDERS: 'brave' },
      });
      return { code: 0, out: stdout };
    } catch (err) {
      return { code: err.code, out: `${err.stdout}${err.stderr}` };
    }
  };

  beforeAll(async () => {
    await createSchema();
    db = await import('../../src/db.js');
    await resetData((...a) => db.query(...a));
    const clients = await import('../../src/api/clients.js');
    await clients.addClient({ name: 'alice' });
    await clients.addClient({ name: 'bob' });
  });

  afterAll(async () => {
    await db?.closePool();
    await dropSchema();
  });

  it('communauté : création, membres, plafond, liste', async () => {
    expect((await cli('community', 'add', '--slug', 'atelier', '--label', 'Atelier')).out).toContain('Communauté "atelier" créée');
    expect((await cli('community', 'join', '--slug', 'atelier', '--name', 'alice', '--role', 'owner')).out)
      .toContain('"alice" membre (owner) de "atelier", sans plafond');
    expect((await cli('community', 'join', '--slug', 'atelier', '--name', 'bob', '--monthly', '0')).out)
      .toContain('plafond 0 giri / 30 jours');
    expect((await cli('community', 'join', '--slug', 'atelier', '--name', 'bob', '--monthly', 'none')).out).toContain('sans plafond');
    const bad = await cli('community', 'join', '--slug', 'atelier', '--name', 'bob', '--monthly=-1');
    expect(bad).toMatchObject({ code: 1, out: expect.stringContaining('--monthly doit être un entier ≥ 0 ou none') });
    expect((await cli('community', 'list')).out).toMatch(/atelier\s+0 giri\s+membres : alice:owner, bob:member/);
    expect((await cli('community', 'nope')).code).toBe(1);
  });

  it('portefeuilles : don, apport au pot, correction, solde ; validations', async () => {
    expect((await cli('wallet', 'credit', '--name', 'bob', '--eur', '1', '--ref', 'a')).out).toContain('sous le minimum');
    expect((await cli('wallet', 'credit', '--name', 'bob', '--eur', '1', '--ref', 'a', '--force')).out)
      .toContain('Don de 1,00 € : +1000 giri, solde 1000 giri');
    expect((await cli('wallet', 'credit', '--community', 'atelier', '--by', 'alice', '--eur', '2,50', '--ref', 'b')).out)
      .toContain('Apport à la communauté par alice de 2,50 € : +2500 giri');
    expect((await cli('wallet', 'credit', '--name', 'bob', '--eur', 'abc', '--ref', 'c')).out).toContain('Montant en euros invalide');
    expect((await cli('wallet', 'adjust', '--name', 'bob', '--giri', 'x', '--note', 'n')).out).toContain('--giri=-50');
    expect((await cli('wallet', 'adjust', '--name', 'bob', '--giri=-100', '--note', 'geste')).out).toContain('solde 900 giri');
    const show = await cli('wallet', 'show', '--community', 'atelier');
    expect(show.out).toContain('Solde : 2500 giri');
    expect(show.out).toMatch(/\+2500\s+purchase\s+b \(alice\)/);
    expect((await cli('wallet', 'nope')).code).toBe(1);
  });

  it('prix, recherches (liste, annulation, exécution en échec : code 1) et rapport', async () => {
    expect((await cli('pricing')).out).toMatch(/brave\s+10 giri l'appel/);
    const { createRequest } = await import('../../src/requests/index.js');
    const prices = [{ provider: 'brave', unit_price: 10, max_pages: 3 }];
    const { rows } = await db.query(`SELECT id FROM api_client WHERE name = 'bob'`);
    const a = await createRequest({ clientId: Number(rows[0].id), prices, provider: 'brave', query: 'a' });
    await createRequest({ clientId: Number(rows[0].id), prices, provider: 'brave', query: 'b' });
    expect((await cli('requests', 'list', '--status', 'queued')).out).toMatch(/#\d+\s+queued\s+bob\s+brave\s+10 giri\s+« b »/);
    expect((await cli('requests', 'list', '--status', 'perdu')).code).toBe(1);
    expect((await cli('requests', 'cancel', '--id', String(a.request.id))).out).toContain('10 giri remboursés');
    // BRAVE_API_KEY vide : l'appel échoue, la recherche est remboursée, le code de sortie vaut 1
    const runRes = await cli('requests', 'run', '--offline');
    expect(runRes.code).toBe(1);
    expect(runRes.out).toMatch(/0 appel\(s\), 0 URLs nouvelles, 10 giri remboursés ; erreur : .*BRAVE_API_KEY/);
    expect((await cli('requests', 'run', '--offline')).out).toContain('Aucune recherche en attente.');
    const report = await cli('billing', 'report', '--days', '7');
    expect(report.out).toContain('dons   : 1, 1.00 €, 1000 giri');
    expect(report.out).toContain('apports : 1, 2.50 €, 2500 giri');
    expect(report.out).toMatch(/encours : 900 giri personnels, 2500 giri de communautés/);
    expect((await cli('billing', 'nope')).code).toBe(1);
    expect((await cli('requests', 'nope')).code).toBe(1);
  });

  it('normalize et classify à la main attendent leur tour pendant un cycle', async () => {
    const { withPipelineLock } = await import('../../src/lock.js');
    let res;
    await withPipelineLock(async () => {
      res = await cli('normalize', '--offline');
    });
    expect(res).toMatchObject({ code: 1, out: expect.stringContaining('cycle ou requests run en cours') });
    expect((await cli('normalize', '--offline')).code).toBe(0);
  });
});
