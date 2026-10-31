import fs from 'node:fs';
import path from 'node:path';
import { defaultDatabaseUrl, intEnv, loadDotEnv, numberEnv, ratioEnv, rootDir } from './env.js';

loadDotEnv();

function readRevision() {
  try {
    return fs.readFileSync(path.join(rootDir, 'REVISION'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

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
  // Médias (webpool media) : cache hors du dossier remplacé au déploiement
  // (~/www/webpool-data/media sur alwaysdata) ; par défaut var/media du dépôt.
  mediaDir: process.env.WEBPOOL_MEDIA_DIR || path.join(rootDir, 'var', 'media'),
  mediaMaxBytes: intEnv('WEBPOOL_MEDIA_MAX_BYTES', 5 * 1024 * 1024, 1),
  mediaConcurrency: intEnv('WEBPOOL_MEDIA_CONCURRENCY', 4, 1),
  // API HTTP (webpool serve) : PORT et IP sont fournis par l'hébergeur (alwaysdata)
  apiPort: process.env.WEBPOOL_API_PORT ? intEnv('WEBPOOL_API_PORT', 3000, 1) : intEnv('PORT', 3000, 1),
  apiHost: process.env.WEBPOOL_API_HOST || process.env.IP || '127.0.0.1',
  // origines autorisées par CORS (interface datapool), séparées par des virgules
  apiCorsOrigins: (process.env.WEBPOOL_API_CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  // Recherches payantes (webpool requests) : prix d'un appel en giri entiers,
  // coût du provider × cours USD→EUR × majoration × giri par euro, arrondi au-dessus.
  giriPerEur: intEnv('WEBPOOL_GIRI_PER_EUR', 1000, 1),
  usdEur: numberEnv('WEBPOOL_USD_EUR', 0.92, { min: 0, exclusive: true }),
  priceMarkup: numberEnv('WEBPOOL_PRICE_MARKUP', 2, { min: 1 }),
  // coûts par appel en USD qui remplacent ceux du code : "brave=0.005,searxng=0"
  callCostsUsd: process.env.WEBPOOL_CALL_COST_USD ?? '',
  requestProviders: (process.env.WEBPOOL_REQUEST_PROVIDERS || 'openrouter,brave')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean),
  requestMaxPages: intEnv('WEBPOOL_REQUEST_MAX_PAGES', 3, 1),
  requestMaxQueued: intEnv('WEBPOOL_REQUEST_MAX_QUEUED', 5, 1),
  // page de don ou d'achat de giri affichée par l'interface
  fundingUrl: process.env.WEBPOOL_FUNDING_URL || null,
  userAgent: `webpool/${version} (+https://github.com/RebelliousSmile/webpool)`,
  version,
  // commit déployé, écrit par scripts/deploy.mjs dans REVISION ; null en développement
  revision: readRevision(),
});
