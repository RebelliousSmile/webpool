import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DATABASE_URL_CHECK,
  DEPLOY_PATHS,
  ENV_KEYS_CHECK,
  healthMatches,
  mediaDirProblem,
  restartRequest,
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
      mediaDir: 'www/webpool-data/media',
      apiUrl: null,
      apiSiteId: null,
      account: 'compte',
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

  it("lit l'API et le cache de médias de la cible, et refuse les valeurs douteuses", () => {
    const t = validateTarget('ad', { ...RAW, apiUrl: 'https://api.ex.org/api/v1/', apiSiteId: 1234, mediaDir: 'www/data/media' });
    expect(t).toMatchObject({ apiUrl: 'https://api.ex.org/api/v1', apiSiteId: 1234, mediaDir: 'www/data/media' });
    expect(() => validateTarget('ad', { ...RAW, apiUrl: 'http://api.ex.org' })).toThrow(/https/);
    expect(() => validateTarget('ad', { ...RAW, apiUrl: 'pas une url' })).toThrow(/illisible/);
    expect(() => validateTarget('ad', { ...RAW, apiSiteId: '12' })).toThrow(/apiSiteId/);
    expect(() => validateTarget('ad', { ...RAW, apiSiteId: 0 })).toThrow(/apiSiteId/);
    for (const mediaDir of ['www/webpool', 'www/webpool/var/media', 'www/webpool.old/media']) {
      expect(() => validateTarget('ad', { ...RAW, mediaDir })).toThrow(/mediaDir/);
    }
    expect(() => validateTarget('ad', { ...RAW, mediaDir: '../x' })).toThrow(/relatif/);
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

describe('DATABASE_URL_CHECK', () => {
  const run = (url) => {
    const dir = mkdtempSync(join(tmpdir(), 'webpool-env-'));
    const file = join(dir, 'x.env');
    writeFileSync(file, url === undefined ? 'AUTRE=1\n' : `DATABASE_URL=${url}\n`);
    try {
      // process.loadEnvFile n'écrase pas une variable déjà définie : sans ce
      // retrait, la DATABASE_URL de l'environnement (la CI en pose une)
      // masquerait celle du fichier.
      const env = { ...process.env };
      delete env.DATABASE_URL;
      return execFileSync(process.execPath, ['-e', DATABASE_URL_CHECK, file], { encoding: 'utf8', env });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('accepte une URL encodée sur le port 5432', () => {
    expect(run('postgres://u:a%25b%40c@h.example:5432/base')).toBe('');
  });

  it('diagnostique sans jamais recopier le mot de passe', () => {
    const out = run('postgres://u:SECRETx5%gH@h.example:5432/base');
    expect(out).toMatch(/mot de passe mal encodé/);
    expect(out).not.toMatch(/SECRET/);
  });

  it('refuse une URL absente, le port 5433 et un autre schéma', () => {
    expect(run(undefined)).toBe('absente');
    expect(run('postgres://u:p@h.example:5433/base')).toMatch(/5433/);
    expect(run('mysql://u:p@h.example/base')).toMatch(/schéma/);
  });
});

describe('API et médias sur la cible', () => {
  it('livre openapi.json, servi par l’API', () => {
    expect(DEPLOY_PATHS).toContain('openapi.json');
  });

  it('exige un WEBPOOL_MEDIA_DIR absolu qui désigne le cache de la cible', () => {
    expect(mediaDirProblem('/home/compte/www/webpool-data/media', '/home/compte', 'www/webpool-data/media')).toBe('');
    expect(mediaDirProblem('/home/compte/www/webpool-data/media/', '/home/compte', 'www/webpool-data/media')).toBe('');
    expect(mediaDirProblem(null, '/home/compte', 'www/webpool-data/media')).toMatch(/absente.*var\/media/);
    expect(mediaDirProblem('$HOME/www/webpool-data/media', '/home/compte', 'www/webpool-data/media')).toMatch(/sans \$HOME/);
  });

  it("ne fait sortir du fichier env que les clés demandées", () => {
    const dir = mkdtempSync(join(tmpdir(), 'webpool-env-'));
    const file = join(dir, 'x.env');
    writeFileSync(file, 'DATABASE_URL=postgres://u:secret@h/b\nWEBPOOL_MEDIA_DIR=/m\n');
    const env = { ...process.env };
    delete env.WEBPOOL_MEDIA_DIR;
    delete env.WEBPOOL_API_CORS_ORIGINS;
    try {
      const out = execFileSync(process.execPath, ['-e', ENV_KEYS_CHECK, file, 'WEBPOOL_MEDIA_DIR', 'WEBPOOL_API_CORS_ORIGINS'], { encoding: 'utf8', env });
      expect(JSON.parse(out)).toEqual({ WEBPOOL_MEDIA_DIR: '/m', WEBPOOL_API_CORS_ORIGINS: null });
      expect(out).not.toContain('secret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("construit la requête de redémarrage de l'API alwaysdata", () => {
    const { url, init } = restartRequest({ token: 'TOK', account: 'compte', siteId: 1234 });
    expect(url).toBe('https://api.alwaysdata.com/v1/site/1234/restart/');
    expect(init.method).toBe('POST');
    expect(Buffer.from(init.headers.Authorization.replace('Basic ', ''), 'base64').toString()).toBe('TOK account=compte:');
    expect(() => restartRequest({ token: '', account: 'compte', siteId: 1 })).toThrow(/ALWAYSDATA_API_TOKEN/);
  });

  it('ne reconnaît que le commit livré dans /health', () => {
    expect(healthMatches({ ok: true, revision: 'abc' }, 'abc')).toBe(true);
    expect(healthMatches({ ok: true, revision: 'old' }, 'abc')).toBe(false);
    expect(healthMatches({ ok: true, revision: null }, 'abc')).toBe(false);
    expect(healthMatches(null, 'abc')).toBe(false);
  });
});
