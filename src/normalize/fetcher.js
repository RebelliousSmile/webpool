// US-10 — récupération de pages polie : délai par hôte, retry borné avec
// backoff, lecture du corps limitée, concurrence bornée entre hôtes.
// `fetchImpl`, `lookup`, `sleep` et `now` sont injectables pour les tests.
// Les requêtes passent par un dispatcher undici dont la résolution DNS applique
// la garde d'hôte à la connexion (contre le DNS rebinding).
import { Agent, fetch as undiciFetch } from 'undici';
import { config } from '../config.js';
import { HostRefusedError, assertPublicHost, createConnectLookup } from './hostGuard.js';

const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_RETRY_AFTER_MS = 10_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.httpStatus = status;
  }
}

export class TooManyRedirectsError extends Error {
  constructor(url, max) {
    super(`trop de redirections : plus de ${max} depuis ${url}`);
    this.retryable = false;
  }
}

export function isTransientStatus(status) {
  return status === 429 || status >= 500;
}

function retryAfterMs(res) {
  const header = res.headers?.get?.('retry-after');
  const seconds = header == null ? NaN : Number(header);
  return Number.isFinite(seconds) ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : null;
}

// Lit le corps jusqu'à `maxBytes` ou jusqu'à </head> : seuls titre et canonical
// (dans le <head>) sont utiles, inutile de télécharger la page entière.
export async function readHead(res, maxBytes) {
  const reader = res.body?.getReader?.();
  if (!reader) return (await res.text()).slice(0, maxBytes);
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (/<\/head\s*>/i.test(text)) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const end = /<\/head\s*>/i.exec(text);
  return text.slice(0, end ? end.index + end[0].length : maxBytes);
}

// Lecture par défaut : le <head> d'une page HTML ; pour un autre type, rien
// (le Content-Type suffit à classer la ressource).
async function readPage(res, maxBytes) {
  const contentType = res.headers.get('content-type') ?? '';
  const isHtml = contentType.includes('text/html');
  const html = isHtml ? await readHead(res, maxBytes) : '';
  if (!isHtml) await res.body?.cancel?.().catch(() => {});
  return { html, contentType };
}

// Corps entier en octets, refusé au-delà de `maxBytes` (vignettes, favicons).
export async function readBytes(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel?.().catch(() => {});
    throw Object.assign(new Error(`trop volumineux : ${declared} octets (max ${maxBytes})`), { retryable: false });
  }
  const reader = res.body?.getReader?.();
  if (!reader) return Buffer.from(await res.arrayBuffer());
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw Object.assign(new Error(`trop volumineux : plus de ${maxBytes} octets`), { retryable: false });
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

// Agent undici partagé par un fetcher : chaque connexion résout l'hôte et
// refuse une adresse non publique, puis se connecte à l'adresse jugée.
export function guardedAgent(lookup) {
  return new Agent({ connect: { lookup: createConnectLookup(lookup ? { lookup } : {}) } });
}

// fetch enveloppe l'erreur de connexion (« fetch failed ») : le refus de la
// garde remonte tel quel, non rejouable.
function unwrapRefusal(err) {
  let cause = err;
  while (cause && !(cause instanceof HostRefusedError)) cause = cause.cause;
  throw cause ?? err;
}

export function createFetcher({
  perHostDelayMs = config.hostDelayMs,
  retries = config.fetchRetries,
  backoffMs = config.fetchBackoffMs,
  maxBodyBytes = config.maxBodyBytes,
  timeoutMs = config.fetchTimeoutMs,
  maxRedirects = config.maxRedirects,
  allowPrivateHosts = config.allowPrivateHosts,
  fetchImpl = undiciFetch,
  lookup,
  // dispatcher undici ; par défaut, un Agent dont la connexion passe la garde d'hôte
  dispatcher = allowPrivateHosts ? undefined : guardedAgent(lookup),
  sleep = sleepReal,
  now = Date.now,
  // (res, maxBodyBytes) → objet fusionné dans le résultat ; `accept` : en-tête Accept
  read = readPage,
  accept = 'text/html,*/*;q=0.8',
} = {}) {
  const nextSlot = new Map();

  // Réservation synchrone d'un créneau par hôte : les appels concurrents vers
  // un même hôte sont espacés de perHostDelayMs.
  async function throttle(host) {
    const slot = Math.max(now(), nextSlot.get(host) ?? 0);
    nextSlot.set(host, slot + perHostDelayMs);
    const wait = slot - now();
    if (wait > 0) await sleep(wait);
  }

  // Redirections suivies à la main : chaque saut passe la garde d'hôte et
  // réserve son créneau de politesse. Renvoie la dernière réponse et son URL.
  async function fetchChain(rawUrl) {
    let url = rawUrl;
    for (let hops = 0; ; hops += 1) {
      const { hostname, host } = new URL(url);
      await assertPublicHost(hostname, { lookup, allowPrivate: allowPrivateHosts });
      await throttle(host);
      const res = await fetchImpl(url, {
        redirect: 'manual',
        headers: { 'User-Agent': config.userAgent, Accept: accept },
        signal: AbortSignal.timeout(timeoutMs),
        ...(dispatcher ? { dispatcher } : {}),
      }).catch(unwrapRefusal);
      const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get('location') : null;
      if (!location) return { res, url };
      await res.body?.cancel?.().catch(() => {});
      if (hops >= maxRedirects) throw new TooManyRedirectsError(rawUrl, maxRedirects);
      url = new URL(location, url).href;
    }
  }

  // Les retries rejouent la chaîne entière ; garde et limite de redirections
  // ne sont pas rejouables.
  return async function fetchPage(rawUrl) {
    for (let attempt = 0; ; attempt += 1) {
      const last = attempt >= retries;
      let res;
      let url;
      try {
        ({ res, url } = await fetchChain(rawUrl));
      } catch (err) {
        if (last || err.retryable === false) throw err;
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }
      if (isTransientStatus(res.status) && !last) {
        const wait = retryAfterMs(res) ?? backoffMs * 2 ** attempt;
        await res.body?.cancel?.().catch(() => {});
        await sleep(wait);
        continue;
      }
      if (res.status >= 300) {
        await res.body?.cancel?.().catch(() => {});
        return { finalUrl: url, httpStatus: res.status, html: '', contentType: res.headers.get('content-type') ?? '' };
      }
      return { finalUrl: url, httpStatus: res.status, ...(await read(res, maxBodyBytes)) };
    }
  };
}

// Exécute `fn` sur chaque élément avec au plus `limit` appels simultanés ;
// retourne des résultats {value}|{error} dans l'ordre d'entrée (jamais de rejet).
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      try {
        results[i] = { value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
