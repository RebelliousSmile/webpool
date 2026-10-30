import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const cwd = fileURLToPath(new URL('..', import.meta.url));

// Ces cas échouent avant toute connexion : aucune base n'est requise.
async function cli(...args) {
  try {
    const { stdout, stderr } = await run(process.execPath, ['bin/webpool.js', ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

describe('CLI', () => {
  it("affiche l'aide", async () => {
    const { code, stdout } = await cli('--help');
    expect(code).toBe(0);
    expect(stdout).toContain('pool create');
    expect(stdout).toContain('--force');
  });

  it('refuse une commande inconnue avec le code 1', async () => {
    const { code, stderr } = await cli('frobnicate');
    expect(code).toBe(1);
    expect(stderr).toContain('Commande inconnue : frobnicate');
  });

  it('refuse une sous-commande pool inconnue avec le code 1', async () => {
    const { code, stderr } = await cli('pool', 'frobnicate');
    expect(code).toBe(1);
    expect(stderr).toContain('Sous-commande pool inconnue : frobnicate');
  });

  it('refuse une sous-commande domain inconnue avec le code 1', async () => {
    const { code, stderr } = await cli('domain', 'frobnicate');
    expect(code).toBe(1);
    expect(stderr).toContain('Sous-commande domain inconnue : frobnicate');
  });

  it('refuse --usage hors liste avant toute connexion', async () => {
    const { code, stderr } = await cli('domain', 'set', '--domain', 'a.com', '--usage', 'gratuit');
    expect(code).toBe(1);
    expect(stderr).toContain('--usage invalide : "gratuit" (attendu : libre, sous-conditions, payant, non-commercial)');
  });

  it.each([['abc'], ['-3'], ['0'], ['1.5']])('refuse --limit=%s avec le code 1', async (value) => {
    const { code, stderr } = await cli('classify', `--limit=${value}`);
    expect(code).toBe(1);
    expect(stderr).toContain('--limit doit être un entier > 0');
  });
});
