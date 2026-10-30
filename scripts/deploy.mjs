// Déploie le CLI webpool sur un compte alwaysdata (SSH + PostgreSQL du compte).
//
//   pnpm deploy:prod <cible> --check   validations et staging locaux, sans contacter la cible
//   pnpm deploy:prod <cible>           prévisualisation (lectures distantes seulement)
//   pnpm deploy:prod <cible> --apply   sauvegarde de la base, migrations, bascule
//
// Seul le contenu d'un commit part (git archive, en LF), jamais la copie de
// travail. Les dépendances sont installées dans un staging Linux natif (WSL),
// puis l'ensemble est synchronisé dans <appDir>.new (défaut ~/www/webpool), migré
// et basculé sur <appDir>, fermé au web par un .htaccess.
// Le .env de production vit hors du dépôt (<envFile>, lié en <appDir>/.env) :
// la cible en est seule propriétaire.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEPLOY_PATHS,
  HTACCESS_DENY,
  assertNodeSupported,
  assertWslHome,
  backupFileName,
  missingKeyHelp,
  parseArgs,
  parseItemized,
  shQuote,
  sshOptions,
  validateTarget,
  withRemoteLock,
} from './deploy-lib.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const options = parseArgs(process.argv.slice(2));

function git(args, extra = {}) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8', ...extra });
}

// --exec : aucun shell WSL ne réinterprète les arguments.
function wsl(args, extra = {}) {
  return execFileSync('wsl', ['--exec', ...args], { encoding: 'utf-8', ...extra });
}

// --- Cible ------------------------------------------------------------------

const targetsPath = join(repoRoot, 'deploy', 'targets.json');
if (!existsSync(targetsPath)) {
  throw new Error('deploy/targets.json absent : copier deploy/targets.example.json et le renseigner (fichier ignoré par git)');
}
const target = validateTarget(options.target, JSON.parse(readFileSync(targetsPath, 'utf-8'))[options.target]);
const node = `NODEJS_VERSION=${target.nodeVersion} node`;

// --- Validations locales ----------------------------------------------------

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
if (branch !== 'main' && !options.anyBranch) {
  throw new Error(`Déploiement refusé : branche « ${branch} », attendu « main » (forcer avec --any-branch)`);
}
const commit = git(['rev-parse', 'HEAD']).trim();
const shortCommit = commit.slice(0, 7);
if (git(['status', '--porcelain']).trim()) {
  console.warn(`⚠ Copie de travail modifiée : ces changements ne partiront pas, seul le commit ${shortCommit} est envoyé.`);
}
const { version } = JSON.parse(git(['show', `${commit}:package.json`]));
console.log(`webpool v${version} — commit ${shortCommit} (${branch}) → cible ${target.name} (${target.remote}:~/${target.appDir})`);

// --- Staging Linux natif (WSL) ----------------------------------------------

const wslHome = assertWslHome(wsl(['printenv', 'HOME']).trim());
const stageDir = `${wslHome}/deploy-stage/webpool-${target.name}`;
// git archive applique la conversion de fin de ligne de la copie de travail :
// avec core.autocrlf=true (Windows), il produirait du CRLF.
const archive = execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', commit, '--', ...DEPLOY_PATHS], {
  cwd: repoRoot,
  maxBuffer: 64 * 1024 * 1024,
});
wsl(['bash', '-c', 'rm -rf "$1" && mkdir -p "$1" && tar -xf - -C "$1"', 'stage', stageDir], { input: archive });
// WSL hérite du PATH Windows : sans ~/.local/bin en tête, « pnpm » résoudrait
// vers le pnpm.exe Windows.
wsl(['bash', '-lc', 'export PATH="$HOME/.local/bin:$PATH" && cd "$1" && pnpm install --prod --frozen-lockfile', 'install', stageDir], { stdio: 'inherit' });
console.log(`Staging : ${stageDir}`);

if (options.check) {
  console.log('Validations locales OK — aucune connexion à la cible.');
  process.exit(0);
}

// --- Accès distant ----------------------------------------------------------

const keyPath = target.sshKey.replace(/^~/, wslHome);
try {
  wsl(['test', '-f', keyPath]);
} catch {
  throw new Error(missingKeyHelp({ keyPath, sshKey: target.sshKey, remote: target.remote, comment: `webpool-${target.name}` }));
}

const sshOpts = sshOptions(keyPath, wslHome);

function ssh(remoteCommand, { inherit = false } = {}) {
  return wsl(['ssh', ...sshOpts, target.remote, remoteCommand], inherit ? { stdio: 'inherit' } : {});
}

function rsync(destDir, { dryRun, linkDest }) {
  const args = ['rsync', '-rlz', '--delete', '--checksum', '--chmod=D755,F644', '--itemize-changes'];
  if (dryRun) args.push('--dry-run');
  // relatif au répertoire de destination : les fichiers inchangés sont des liens durs
  if (linkDest) args.push(`--link-dest=../${basename(target.appDir)}`);
  args.push('--exclude=/.env', '--exclude=/.htaccess', '-e', `ssh ${sshOpts.join(' ')}`, `${stageDir}/`, `${target.remote}:${destDir}/`);
  return wsl(args);
}

// --- État de la cible -------------------------------------------------------

const guardRaw = ssh(`cat ${target.guardPath} 2>/dev/null || true`).trim();
if (guardRaw) {
  const guard = JSON.parse(guardRaw);
  const expected = target.guard;
  if (guard.targetId !== expected.targetId || guard.phase !== expected.phase || guard.lifecycleRevision !== expected.lifecycleRevision) {
    throw new Error(`Garde distante incompatible : attendu ${JSON.stringify(expected)}, trouvé ${guardRaw}`);
  }
}

if (ssh(`test -f "$HOME"/${target.envFile} && echo present || echo absent`).trim() !== 'present') {
  throw new Error([
    `~/${target.envFile} absent sur la cible : le créer avant le premier déploiement (chmod 600), au moins avec`,
    '  DATABASE_URL=postgres://<user>:<mdp>@postgresql-<compte>.alwaysdata.net:5432/<base>',
    'Port 5432 et non 5433 (pgBouncer) : migrate prend un verrou consultatif de session.',
  ].join('\n'));
}
const nodeRemote = assertNodeSupported(ssh(`${node} --version`));
if (ssh('command -v pg_dump >/dev/null && echo present || echo absent').trim() !== 'present') {
  throw new Error('pg_dump introuvable sur la cible : la sauvegarde avant migration est impossible');
}
const appExists = ssh(`test -d ${target.appDir} && echo present || echo absent`).trim() === 'present';
const lastRaw = ssh(`cat ${target.stateDir}/last-deploy.json 2>/dev/null || true`).trim();
const previousCommit = lastRaw ? JSON.parse(lastRaw).commit : null;
console.log(`Node ${nodeRemote} sur la cible — en ligne : ${previousCommit ? previousCommit.slice(0, 7) : appExists ? 'version inconnue' : 'rien (premier déploiement)'}`);

// --- Prévisualisation -------------------------------------------------------

const changes = parseItemized(rsync(target.appDir, { dryRun: true, linkDest: false }));
const ownChanges = changes.filter(({ path }) => !path.startsWith('node_modules/'));
const deletions = ownChanges.filter(({ flags }) => flags === '*deleting').length;
console.log(`\n${changes.length} changement(s) par rapport à ~/${target.appDir}, dont ${changes.length - ownChanges.length} dans node_modules ; hors node_modules (${deletions} suppression(s)) :`);
for (const { flags, path } of ownChanges.slice(0, 40)) console.log(`  ${flags} ${path}`);
if (ownChanges.length > 40) console.log(`  … et ${ownChanges.length - 40} autres`);
if (!guardRaw) console.log(`\nGarde absente : elle sera posée dans ~/${target.guardPath}.`);

if (!options.apply) {
  console.log('\nPrévisualisation seulement. Relancer avec --apply pour sauvegarder la base, migrer et basculer.');
  process.exit(0);
}

// --- Application ------------------------------------------------------------

ssh(`mkdir -p ${target.backupDir}`);
if (!guardRaw) ssh(`printf '%s\\n' ${shQuote(JSON.stringify(target.guard))} > ${target.guardPath}`);

await withRemoteLock(ssh, target, async () => {
  // La sauvegarde du déploiement précédent n'est purgée qu'ici, au début du
  // suivant : la restauration reste possible jusque-là.
  ssh(`rm -rf ${target.oldDir} ${target.newDir}`);

  console.log(`\nSynchronisation vers ~/${target.newDir}...`);
  rsync(target.newDir, { dryRun: false, linkDest: appExists });
  ssh(`ln -s "$HOME"/${target.envFile} ${target.newDir}/.env && printf '%s\\n' ${shQuote(HTACCESS_DENY)} > ${target.newDir}/.htaccess && chmod 644 ${target.newDir}/.htaccess`);

  // Preuve des droits sur tout l'arbre livré (répertoires 755, fichiers 644) :
  // un umask complaisant ne peut pas masquer un chemin trop permissif.
  const badModes = ssh(`find ${target.newDir} \\( -type d ! -perm 755 \\) -o \\( -type f ! -perm 644 \\) -print | head -5`).trim();
  if (badModes) throw new Error(`Droits inattendus après synchronisation :\n${badModes}`);

  const backup = `${target.backupDir}/${backupFileName(new Date(), shortCommit)}`;
  console.log(`Sauvegarde de la base → ~/${backup}`);
  // DATABASE_URL lue par le même parseur que le CLI, jamais affichée
  ssh([
    `cd ${target.newDir}`,
    `DATABASE_URL="$(${node} -e 'process.loadEnvFile(".env"); process.stdout.write(process.env.DATABASE_URL ?? "")')"`,
    'test -n "$DATABASE_URL"',
    `pg_dump -Fc -d "$DATABASE_URL" -f "$HOME"/${backup}`,
  ].join(' && '));
  ssh(`ls -1t ${target.backupDir}/webpool-*.dump | tail -n +6 | xargs -r rm --`);

  console.log('Migrations...');
  ssh(`cd ${target.newDir} && ${node} bin/webpool.js migrate`, { inherit: true });

  console.log('Contrôle : webpool stats...');
  ssh(`cd ${target.newDir} && ${node} bin/webpool.js stats > /dev/null`);

  console.log('Bascule...');
  ssh(`if [ -d ${target.appDir} ]; then mv ${target.appDir} ${target.oldDir}; fi && mv ${target.newDir} ${target.appDir}`);
  ssh(`test -L ${target.appDir}/.env && test -f ${target.appDir}/.htaccess && test -f ${target.appDir}/bin/webpool.js`);

  const record = { commit, version, previousCommit, backup, at: new Date().toISOString() };
  ssh(`printf '%s\\n' ${shQuote(JSON.stringify(record))} > ${target.stateDir}/last-deploy.json`);

  const sshCmd = `wsl ssh -i ${target.sshKey} ${target.remote}`;
  console.log('\nRestauration si besoin (jusqu\'au prochain déploiement) :');
  if (appExists) console.log(`  code   : ${sshCmd} "mv ${target.appDir} ${target.appDir}.broken && mv ${target.oldDir} ${target.appDir}"`);
  console.log(`  schéma : pg_restore --clean --if-exists -d "$DATABASE_URL" ~/${backup}  (sur la cible)`);
});

console.log(`\nDéployé : webpool v${version} (${shortCommit}) sur ${target.name}.`);
