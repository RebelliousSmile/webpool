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
  hostDelayMs: Number(process.env.WEBPOOL_HOST_DELAY_MS ?? 1000),
  fetchRetries: Number(process.env.WEBPOOL_FETCH_RETRIES ?? 2),
  fetchBackoffMs: Number(process.env.WEBPOOL_FETCH_BACKOFF_MS ?? 500),
  maxBodyBytes: Number(process.env.WEBPOOL_MAX_BODY_BYTES ?? 262144),
  concurrency: Number(process.env.WEBPOOL_CONCURRENCY ?? 4),
  userAgent: 'webpool/0.1 (+https://github.com/RebelliousSmile/webpool)',
};
