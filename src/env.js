import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Environnement partagé par le CLI et les tests, sans état : n'importe rien du projet,
// pour que les helpers d'intégration ne chargent jamais le singleton `config`.

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let dotEnvLoaded = false;

// Charge `.env` à la racine une seule fois ; les variables déjà définies l'emportent.
export function loadDotEnv() {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;
  try {
    process.loadEnvFile(path.join(rootDir, '.env'));
  } catch {
    // pas de .env : les défauts s'appliquent
  }
}

// URL du conteneur de développement, sur le port publié par docker-compose.yml.
export function defaultDatabaseUrl(env = process.env) {
  const port = env.WEBPOOL_DB_PORT || '5432';
  return `postgres://webpool:webpool@localhost:${port}/webpool`;
}

// Environnements où le conteneur local sert de base par défaut.
export const DEV_NODE_ENVS = ['', 'development', 'test'];

// DATABASE_URL, ou le conteneur local en développement et en test (NODE_ENV
// absent, development ou test). Ailleurs, son absence arrête net : un serveur de
// production ne se rabat jamais sur des identifiants publics.
export function resolveDatabaseUrl(env = process.env) {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const nodeEnv = env.NODE_ENV ?? '';
  if (DEV_NODE_ENVS.includes(nodeEnv)) return defaultDatabaseUrl(env);
  throw new Error(
    `DATABASE_URL absente (NODE_ENV=${nodeEnv}) : la définir dans l'environnement ou dans .env, ` +
      'par exemple DATABASE_URL=postgres://<utilisateur>:<mot de passe>@<hôte>:5432/<base>. ' +
      'Le conteneur local (webpool:webpool) ne sert de défaut que si NODE_ENV est absent, development ou test.',
  );
}

// Entier lu dans l'environnement, borné par `min` ; une valeur invalide arrête net.
export function intEnv(name, fallback, min = 0, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} doit être un entier ≥ ${min} (reçu : "${raw}")`);
  }
  return value;
}

// Nombre décimal lu dans l'environnement, borné par `min` (exclu si `exclusive`) ;
// une valeur invalide arrête net.
export function numberEnv(name, fallback, { min = 0, exclusive = false } = {}, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || (exclusive ? value <= min : value < min)) {
    throw new Error(`${name} doit être un nombre ${exclusive ? '>' : '≥'} ${min} (reçu : "${raw}")`);
  }
  return value;
}

// Fraction lue dans l'environnement, entre 0 et 1 ; une valeur invalide arrête net.
export function ratioEnv(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} doit être un nombre entre 0 et 1 (reçu : "${raw}")`);
  }
  return value;
}
