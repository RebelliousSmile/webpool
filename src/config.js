import fs from 'node:fs';
import path from 'node:path';
import { defaultDatabaseUrl, intEnv, loadDotEnv, ratioEnv, rootDir } from './env.js';

loadDotEnv();

const { version } = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

// Gelée : les réglages se passent en paramètre (tests compris), jamais par mutation.
export const config = Object.freeze({
  rootDir,
  databaseUrl: process.env.DATABASE_URL ?? defaultDatabaseUrl(),
  braveApiKey: process.env.BRAVE_API_KEY ?? '',
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
  openrouterEngine: process.env.OPENROUTER_ENGINE || 'perplexity',
  openrouterModel: process.env.OPENROUTER_MODEL || 'openai/gpt-4.1-nano',
  openrouterTimeoutMs: intEnv('OPENROUTER_TIMEOUT_MS', 60000, 1),
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
  normalizeChunk: intEnv('WEBPOOL_NORMALIZE_CHUNK', 100, 1),
  maxRedirects: intEnv('WEBPOOL_MAX_REDIRECTS', 5, 0),
  // exploration : repos d'une requête épuisée, passages sans URL nouvelle avant épuisement
  exploreRestDays: intEnv('WEBPOOL_EXPLORE_REST_DAYS', 30, 0),
  exploreDryRuns: intEnv('WEBPOOL_EXPLORE_DRY_RUNS', 2, 1),
  // exclusion : URLs au-delà desquelles un domaine est saturé, longueur maximale de la requête envoyée
  exploreSaturation: intEnv('WEBPOOL_EXPLORE_SATURATION', 50, 1),
  exploreQueryMaxChars: intEnv('WEBPOOL_EXPLORE_QUERY_MAX_CHARS', 400, 1),
  // tuyaux : note d'un domaine bien noté, appels par mesure, baisse qui fait passer au suivant
  pipeGoodScore: ratioEnv('WEBPOOL_PIPE_GOOD_SCORE', 0.5),
  pipeWindow: intEnv('WEBPOOL_PIPE_WINDOW', 3, 1),
  pipeDropRatio: ratioEnv('WEBPOOL_PIPE_DROP_RATIO', 0.5),
  // intranet assumé : désactive la garde d'hôte de la normalisation
  allowPrivateHosts: ['1', 'true'].includes(process.env.WEBPOOL_ALLOW_PRIVATE_HOSTS ?? ''),
  userAgent: `webpool/${version} (+https://github.com/RebelliousSmile/webpool)`,
});
