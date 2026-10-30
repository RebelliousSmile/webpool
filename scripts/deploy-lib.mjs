// Fonctions pures du déploiement (scripts/deploy.mjs) : aucune n'appelle git, WSL
// ni le réseau, pour rester testables par vitest. withRemoteLock reçoit la
// fonction ssh en paramètre pour la même raison.

// Liste blanche de ce qui part sur la cible : le CLI, son schéma, sa taxonomie et
// de quoi installer ses dépendances. Tests, fixtures, outillage et docs restent locaux.
export const DEPLOY_PATHS = ['bin', 'config', 'db', 'src', 'package.json', 'pnpm-lock.yaml', 'LICENSE'];

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
