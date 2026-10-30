import { describe, expect, it, vi } from 'vitest';
import {
  assertNodeSupported,
  assertWslHome,
  backupFileName,
  parseArgs,
  parseItemized,
  shQuote,
  validateRemoteRelativePath,
  validateTarget,
  withRemoteLock,
} from '../scripts/deploy-lib.mjs';

const RAW = { host: 'ssh-compte.alwaysdata.net', user: 'compte', sshKey: '~/.ssh/webpool_ci', lifecycleRevision: 1 };

describe('parseArgs', () => {
  it('exige une cible unique', () => {
    expect(() => parseArgs([])).toThrow(/Cible manquante/);
    expect(() => parseArgs(['ad', 'autre'])).toThrow(/Une seule cible/);
  });

  it('lit les options et ignore le séparateur --', () => {
    expect(parseArgs(['ad', '--', '--apply'])).toMatchObject({ target: 'ad', apply: true, check: false });
  });

  it('refuse une option inconnue et --apply avec --check', () => {
    expect(() => parseArgs(['ad', '--force'])).toThrow(/Option inconnue/);
    expect(() => parseArgs(['ad', '--apply', '--check'])).toThrow(/incompatibles/);
  });
});

describe('validateTarget', () => {
  it('applique les défauts et dérive les chemins de la cible', () => {
    const t = validateTarget('ad', RAW);
    expect(t).toMatchObject({
      remote: 'compte@ssh-compte.alwaysdata.net',
      appDir: 'www/webpool',
      newDir: 'www/webpool.new',
      oldDir: 'www/webpool.old',
      envFile: 'www/webpool.env',
      nodeVersion: '24',
      lockPath: 'deploy/webpool-ad/lock',
      guard: { targetId: 'ad', phase: 'production', lifecycleRevision: 1 },
    });
  });

  it('refuse une cible absente, un hôte ou une clé douteux', () => {
    expect(() => validateTarget('ad', undefined)).toThrow(/absente/);
    expect(() => validateTarget('ad', { ...RAW, host: 'a;b' })).toThrow(/host invalide/);
    expect(() => validateTarget('ad', { ...RAW, sshKey: '/etc/key' })).toThrow(/sshKey/);
  });

  it('refuse ~/www comme appDir et les secrets dans le répertoire livré ou ses variantes', () => {
    expect(validateTarget('ad', { ...RAW, appDir: 'www/autre' }).appDir).toBe('www/autre');
    expect(() => validateTarget('ad', { ...RAW, appDir: 'www' })).toThrow(/sous-répertoire/);
    for (const envFile of ['www/webpool/.env', 'www/webpool.new/x.env', 'www/webpool.old/x.env']) {
      expect(() => validateTarget('ad', { ...RAW, envFile })).toThrow(/purgées/);
    }
    expect(validateTarget('ad', { ...RAW, envFile: 'www/webpool-env/x.env' }).envFile).toBe('www/webpool-env/x.env');
  });

  it('refuse une révision de cycle de vie absente et une version de Node non majeure', () => {
    expect(() => validateTarget('ad', { ...RAW, lifecycleRevision: 0 })).toThrow(/lifecycleRevision/);
    expect(() => validateTarget('ad', { ...RAW, nodeVersion: '24.1' })).toThrow(/nodeVersion/);
  });
});

describe('validateRemoteRelativePath', () => {
  it('refuse les chemins absolus, remontants ou à caractères shell', () => {
    for (const bad of ['/home/x', '../x', 'a b', 'a;rm']) {
      expect(() => validateRemoteRelativePath('appDir', bad)).toThrow();
    }
    expect(validateRemoteRelativePath('appDir', 'www/webpool')).toBe('www/webpool');
  });
});

describe('assertWslHome', () => {
  it('accepte /home/<utilisateur> et /root seulement', () => {
    expect(assertWslHome('/home/moi')).toBe('/home/moi');
    expect(assertWslHome('/root')).toBe('/root');
    for (const bad of ['', '/', '/home', '/home/a/b', '/mnt/c/Users']) expect(() => assertWslHome(bad)).toThrow();
  });
});

describe('assertNodeSupported', () => {
  it('suit engines : ^22.12.0 || >=24', () => {
    expect(assertNodeSupported('v22.12.0\n')).toBe('v22.12.0');
    expect(assertNodeSupported('v24.3.1')).toBe('v24.3.1');
    expect(() => assertNodeSupported('v22.11.0')).toThrow(/demande/);
    expect(() => assertNodeSupported('v23.5.0')).toThrow(/demande/);
    expect(() => assertNodeSupported('command not found')).toThrow(/illisible/);
  });
});

describe('shQuote', () => {
  it('protège les apostrophes', () => {
    expect(shQuote(`a'b`)).toBe(`'a'\\''b'`);
  });
});

describe('parseItemized', () => {
  it('garde les fichiers et répertoires modifiés, ignore la racine et le bruit', () => {
    const out = ['.d..t...... ./', '>f+++++++++ bin/webpool.js', 'cd+++++++++ src/', '*deleting   test/x.test.js', 'sending incremental file list', ''].join('\n');
    expect(parseItemized(out)).toEqual([
      { flags: '>f+++++++++', path: 'bin/webpool.js' },
      { flags: 'cd+++++++++', path: 'src/' },
      { flags: '*deleting', path: 'test/x.test.js' },
    ]);
  });
});

describe('backupFileName', () => {
  it('horodate en UTC compact avec le commit', () => {
    expect(backupFileName(new Date('2026-10-30T08:09:10.123Z'), 'abc1234')).toBe('webpool-20261030T080910Z-abc1234.dump');
  });
});

describe('withRemoteLock', () => {
  const target = { lockPath: 'deploy/webpool-ad/lock', sshKey: '~/.ssh/k', remote: 'u@h' };

  it('rend le verrou même si le corps échoue', async () => {
    const ssh = vi.fn();
    await expect(withRemoteLock(ssh, target, () => {
      throw new Error('boum');
    })).rejects.toThrow('boum');
    expect(ssh.mock.calls.map(([cmd]) => cmd)).toEqual(['mkdir deploy/webpool-ad/lock', 'rmdir deploy/webpool-ad/lock']);
  });

  it('échoue sans exécuter le corps si le verrou est pris', async () => {
    const ssh = vi.fn(() => {
      throw new Error('exists');
    });
    const body = vi.fn();
    await expect(withRemoteLock(ssh, target, body)).rejects.toThrow(/Verrou déjà pris/);
    expect(body).not.toHaveBeenCalled();
  });
});
