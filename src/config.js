import fs from 'node:fs';
import path from 'node:path';
import { defaultDatabaseUrl, intEnv, loadDotEnv, rootDir } from './env.js';

loadDotEnv();

const { version } = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

// Gelée : les réglages se passent en paramètre (tests compris), jamais par mutation.
export const config = Object.freeze({
  rootDir,
  databaseUrl: process.env.DATABASE_URL ?? defaultDatabaseUrl(),
  braveApiKey: process.env.BRAVE_API_KEY ?? '',
  searxngUrl: process.env.SEARXNG_URL ?? '',
  europeanaApiKey: process.env.EUROPEANA_API_KEY ?? '',
  flickrApiKey: process.env.FLICKR_API_KEY ?? '',
  taxonomyPath: process.env.WEBPOOL_TAXONOMY ?? path.join(rootDir, 'config', 'taxonomy.json'),
  fetchTimeoutMs: intEnv('WEBPOOL_FETCH_TIMEOUT_MS', 10000, 1),
  hostDelayMs: intEnv('WEBPOOL_HOST_DELAY_MS', 1000, 0),
  fetchRetries: intEnv('WEBPOOL_FETCH_RETRIES', 2, 0),
  fetchBackoffMs: intEnv('WEBPOOL_FETCH_BACKOFF_MS', 500, 0),
  maxBodyBytes: intEnv('WEBPOOL_MAX_BODY_BYTES', 262144, 1),
  concurrency: intEnv('WEBPOOL_CONCURRENCY', 4, 1),
  maxRedirects: intEnv('WEBPOOL_MAX_REDIRECTS', 5, 0),
  // intranet assumé : désactive la garde d'hôte de la normalisation
  allowPrivateHosts: ['1', 'true'].includes(process.env.WEBPOOL_ALLOW_PRIVATE_HOSTS ?? ''),
  userAgent: `webpool/${version} (+https://github.com/RebelliousSmile/webpool)`,
});
