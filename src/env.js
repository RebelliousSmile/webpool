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
