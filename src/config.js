import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(path.join(rootDir, '.env'));
} catch {
  // pas de .env : les défauts ci-dessous s'appliquent
}

export const config = {
  rootDir,
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://webpool:webpool@localhost:5432/webpool',
  braveApiKey: process.env.BRAVE_API_KEY ?? '',
  taxonomyPath: process.env.WEBPOOL_TAXONOMY ?? path.join(rootDir, 'config', 'taxonomy.json'),
  fetchTimeoutMs: Number(process.env.WEBPOOL_FETCH_TIMEOUT_MS ?? 10000),
  userAgent: 'webpool/0.1 (+https://github.com/RebelliousSmile/webpool)',
};
