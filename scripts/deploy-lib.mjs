// Fonctions pures du déploiement (scripts/deploy.mjs) : aucune n'appelle git, WSL
// ni le réseau, pour rester testables par vitest. withRemoteLock reçoit la
// fonction ssh en paramètre pour la même raison.

// Liste blanche de ce qui part sur la cible : le CLI, son schéma, sa taxonomie et
// de quoi installer ses dépendances. Tests, fixtures, outillage et docs restent locaux.
// openapi.json : servi par l'API (/api/v1/openapi.json).
export const DEPLOY_PATHS = ['bin', 'config', 'db', 'src', 'openapi.json', 'package.json', 'pnpm-lock.yaml', 'LICENSE'];

const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const SAFE_HOST = /^[a-z0-9.-]+$/i;
const SAFE_USER = /^[a-z0-9._-]+$/i;

const FLAGS = {
  '--apply': 'apply',
  '--check': 'check',
  '--any-branch': 'anyBranch',
};

export function parseArgs(argv) {
  const options = { target: null, apply: false, check: false, anyBranch: false };
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg.startsWith('--')) {
      const key = FLAGS[arg];
      if (!key) throw new Error(`Option inconnue : ${arg}`);
      options[key] = true;
      continue;
    }
    if (options.target) throw new Error(`Une seule cible attendue, reçu « ${options.target} » et « ${arg} »`);
    options.target = arg;
  }
  if (!options.target) throw new Error('Cible manquante : pnpm deploy:prod <cible> [--check | --apply]');
  if (options.apply && options.check) throw new Error('--apply et --check sont incompatibles');
  return options;
}

export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Relatif au home SSH : on ne devine pas /home/<compte>. Le chemin est ensuite
// interpolé sans guillemets dans des commandes distantes, d'où la liste blanche.
export function validateRemoteRelativePath(field, value) {
  if (!SAFE_PATH.test(value ?? '') || value.startsWith('/') || value.includes('..')) {
    throw new Error(`${field} doit être un chemin relatif au home SSH (reçu : ${value})`);
  }
  return value;
}

// Exécuté par node sur la cible (argument : le fichier env). N'écrit qu'un
// diagnostic générique, jamais un fragment de l'URL. Les composants doivent être
// encodés en URL : pg_dump (libpq) refuse un « % » nu.
export const DATABASE_URL_CHECK = `
process.loadEnvFile(process.argv[1]);
const raw = process.env.DATABASE_URL;
let problem = '';
if (!raw) problem = 'absente';
else {
  let url;
  try { url = new URL(raw); } catch { problem = 'URL illisible'; }
  if (url) {
    if (!/^postgres(ql)?:$/.test(url.protocol)) problem = 'schéma attendu postgres://';
    else if (url.port === '5433') problem = 'port 5433 (pgBouncer) : utiliser 5432, migrate prend un verrou consultatif de session';
    else {
      for (const [name, part] of [['utilisateur', url.username], ['mot de passe', url.password], ['base', url.pathname]]) {
        try { decodeURIComponent(part); } catch { problem = name + ' mal encodé en URL (% → %25, @ → %40, : → %3A, / → %2F, # → %23, " → %22)'; break; }
        if (/["\\s]/.test(part)) { problem = name + ' contient un guillemet ou un espace non encodé'; break; }
      }
    }
  }
}
process.stdout.write(problem);
`;

// Posé dans le répertoire livré, en défense si un site venait à servir ~/www :
// .env y est un lien vers le fichier de secrets.
export const HTACCESS_DENY = 'Require all denied';

export function validateTarget(name, raw) {
  if (!/^[a-z0-9-]+$/.test(name ?? '')) throw new Error(`Nom de cible invalide : ${name}`);
  if (!raw || typeof raw !== 'object') throw new Error(`Cible « ${name} » absente de deploy/targets.json`);
  const { host, user, sshKey, lifecycleRevision } = raw;
  if (!SAFE_HOST.test(host ?? '')) throw new Error(`host invalide pour « ${name} » : ${host}`);
  if (!SAFE_USER.test(user ?? '')) throw new Error(`user invalide pour « ${name} » : ${user}`);
  if (!/^~\/\.ssh\/[A-Za-z0-9._-]+$/.test(sshKey ?? '')) {
    throw new Error(`sshKey doit être une clé de ~/.ssh côté WSL (reçu : ${sshKey})`);
  }
  // convention du compte : chaque projet sous ~/www, non exposé
  const appDir = validateRemoteRelativePath('appDir', raw.appDir ?? 'www/webpool');
  // la bascule déplace appDir : jamais le webroot lui-même
  if (/^www\/?$/i.test(appDir)) throw new Error(`appDir doit être un sous-répertoire de ~/www, pas ~/www (reçu : ${appDir})`);
  // Les secrets survivent aux déploiements : hors de appDir et de ses variantes
  // .new/.old, que la bascule déplace puis purge. <appDir>/.env n'est qu'un lien.
  const envFile = validateRemoteRelativePath('envFile', raw.envFile ?? 'www/webpool.env');
  if ([appDir, `${appDir}.new`, `${appDir}.old`].some((dir) => envFile.startsWith(`${dir}/`))) {
    throw new Error(`envFile ne doit pas être dans ${appDir} ni ses variantes .new/.old, purgées par la bascule (reçu : ${envFile})`);
  }
  // Cache de médias (phase 3) : hors de appDir et de ses variantes, comme envFile.
  const mediaDir = validateRemoteRelativePath('mediaDir', raw.mediaDir ?? 'www/webpool-data/media');
  if ([appDir, `${appDir}.new`, `${appDir}.old`].some((dir) => mediaDir === dir || mediaDir.startsWith(`${dir}/`))) {
    throw new Error(`mediaDir ne doit pas être dans ${appDir} ni ses variantes .new/.old (reçu : ${mediaDir})`);
  }
  // API (site Node.js) : URL publique pour le contrôle de santé, identifiant du
  // site pour le redémarrage par l'API alwaysdata. Tous deux facultatifs.
  let apiUrl = null;
  if (raw.apiUrl !== undefined) {
    let url;
    try {
      url = new URL(raw.apiUrl);
    } catch {
      throw new Error(`apiUrl illisible pour « ${name} » : ${raw.apiUrl}`);
    }
    if (url.protocol !== 'https:') throw new Error(`apiUrl doit être en https pour « ${name} » (reçu : ${raw.apiUrl})`);
    apiUrl = url.href.replace(/\/$/, '');
  }
  const apiSiteId = raw.apiSiteId ?? null;
  if (apiSiteId !== null && !(Number.isInteger(apiSiteId) && apiSiteId > 0)) {
    throw new Error(`apiSiteId doit être l'identifiant numérique du site de l'API (reçu : ${raw.apiSiteId})`);
  }
  const nodeVersion = String(raw.nodeVersion ?? '24');
  if (!/^\d+$/.test(nodeVersion)) throw new Error(`nodeVersion doit être une version majeure (reçu : ${nodeVersion})`);
  if (!Number.isInteger(lifecycleRevision) || lifecycleRevision < 1) {
    throw new Error(`lifecycleRevision doit être un entier ≥ 1 pour « ${name} »`);
  }

  const stateDir = `deploy/webpool-${name}`;
  return {
    name,
    remote: `${user}@${host}`,
    sshKey,
    appDir,
    newDir: `${appDir}.new`,
    oldDir: `${appDir}.old`,
    envFile,
    mediaDir,
    apiUrl,
    apiSiteId,
    account: user,
    nodeVersion,
    stateDir,
    guardPath: `${stateDir}/guard.json`,
    lockPath: `${stateDir}/lock`,
    backupDir: `${stateDir}/backups`,
    guard: { targetId: name, phase: 'production', lifecycleRevision },
  };
}

// HOME de WSL, interpolé dans un `rm -rf` de staging : refuser tout ce qui
// n'est pas /home/<utilisateur> ou /root.
export function assertWslHome(home) {
  if (!/^\/(?:root|home\/[A-Za-z0-9._-]+)$/.test(home ?? '')) {
    throw new Error(`HOME de WSL inattendu : « ${home} » (attendu /home/<utilisateur> ou /root)`);
  }
  return home;
}

export function sshOptions(keyPath, wslHome) {
  return [
    '-i', keyPath,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${wslHome}/.ssh/cm-%r@%h:%p`,
    '-o', 'ControlPersist=60s',
  ];
}

export function missingKeyHelp({ keyPath, sshKey, remote, comment }) {
  return [
    `Clé SSH absente côté WSL : ${keyPath}`,
    `  wsl ssh-keygen -t ed25519 -N "" -C ${comment} -f ${sshKey}`,
    `  wsl ssh-copy-id -i ${sshKey}.pub ${remote}`,
  ].join('\n');
}

// engines de package.json : ^22.12.0 || >=24
export function assertNodeSupported(versionOutput) {
  const match = /^v(\d+)\.(\d+)\.\d+/.exec(String(versionOutput).trim());
  if (!match) throw new Error(`Version de Node illisible sur la cible : ${versionOutput}`);
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (!((major === 22 && minor >= 12) || major >= 24)) {
    throw new Error(`Node ${match[0]} sur la cible : webpool demande ^22.12.0 ou >=24`);
  }
  return match[0];
}

// Verrou distant par `mkdir` (atomique) : pris avant `body`, toujours rendu
// après, même si `body` échoue. Un verrou non rendu est signalé, pas masqué.
export async function withRemoteLock(ssh, { lockPath, sshKey, remote }, body) {
  try {
    await ssh(`mkdir ${lockPath}`);
  } catch {
    throw new Error(`Verrou déjà pris (~/${lockPath}) : un autre déploiement est en cours, ou un précédent a été interrompu`);
  }
  try {
    return await body();
  } finally {
    try {
      await ssh(`rmdir ${lockPath}`);
    } catch {
      console.error(`✖ Verrou non libéré : wsl ssh -i ${sshKey} ${remote} "rmdir ${lockPath}"`);
    }
  }
}

// Sortie de `rsync --itemize-changes` : « YXcstpoguax chemin », ou « *deleting chemin »
// pour ce que --delete retire.
export function parseItemized(output) {
  const changes = [];
  for (const line of output.split(/\r?\n/)) {
    const item = /^([<>ch.][fdLDS][^ ]{9}|\*deleting)\s+(.+)$/.exec(line);
    if (!item || item[2] === './') continue;
    changes.push({ flags: item[1], path: item[2] });
  }
  return changes;
}

export function backupFileName(date, commit) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `webpool-${stamp}-${commit}.dump`;
}

// Exécuté par node sur la cible (arguments : le fichier env, puis les clés
// voulues). Seules ces clés sortent du fichier, jamais DATABASE_URL ni les clés
// des providers.
export const ENV_KEYS_CHECK = `
process.loadEnvFile(process.argv[1]);
const out = {};
for (const key of process.argv.slice(2)) out[key] = process.env[key] ?? null;
process.stdout.write(JSON.stringify(out));
`;

// WEBPOOL_MEDIA_DIR doit désigner le cache de la cible, en chemin absolu :
// process.loadEnvFile ne développe pas $HOME. Renvoie le problème, ou ''.
export function mediaDirProblem(value, home, mediaDir) {
  const expected = `${home}/${mediaDir}`;
  if (!value) return `WEBPOOL_MEDIA_DIR absente : le cache irait dans var/media du code, effacé à la bascule suivante (attendu ${expected})`;
  if (value.replace(/\/+$/, '') !== expected) return `WEBPOOL_MEDIA_DIR vaut « ${value} », attendu ${expected} (chemin absolu, sans $HOME)`;
  return '';
}

// Redémarrage d'un site par l'API alwaysdata : authentification HTTP basique,
// identifiant « <jeton> account=<compte> », mot de passe vide. Le jeton reste
// dans le shell local (ALWAYSDATA_API_TOKEN), jamais versionné ni transféré.
export function restartRequest({ token, account, siteId }) {
  if (!token) throw new Error('ALWAYSDATA_API_TOKEN absent');
  const credentials = Buffer.from(`${token} account=${account}:`).toString('base64');
  return {
    url: `https://api.alwaysdata.com/v1/site/${siteId}/restart/`,
    init: { method: 'POST', headers: { Authorization: `Basic ${credentials}` } },
  };
}

// Réponse de /api/v1/health qui prouve que le commit déployé sert.
export const healthMatches = (body, commit) => body?.ok === true && body.revision === commit;
