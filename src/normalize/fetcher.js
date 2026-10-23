// US-10 — récupération de pages polie : délai par hôte, retry borné avec
// backoff, lecture du corps limitée, concurrence bornée entre hôtes.
// `fetchImpl`, `sleep` et `now` sont injectables pour les tests.
import { config } from '../config.js';

const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_RETRY_AFTER_MS = 10_000;

export class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.httpStatus = status;
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

export function createFetcher({
  perHostDelayMs = config.hostDelayMs,
  retries = config.fetchRetries,
  backoffMs = config.fetchBackoffMs,
  maxBodyBytes = config.maxBodyBytes,
  timeoutMs = config.fetchTimeoutMs,
  fetchImpl = fetch,
  sleep = sleepReal,
  now = Date.now,
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

  return async function fetchPage(rawUrl) {
    const host = new URL(rawUrl).host;
    for (let attempt = 0; ; attempt += 1) {
      await throttle(host);
      const last = attempt >= retries;
      let res;
      try {
        res = await fetchImpl(rawUrl, {
          redirect: 'follow',
          headers: { 'User-Agent': config.userAgent, Accept: 'text/html,*/*;q=0.8' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (last) throw err;
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }
      if (isTransientStatus(res.status) && !last) {
        const wait = retryAfterMs(res) ?? backoffMs * 2 ** attempt;
        await res.body?.cancel?.().catch(() => {});
        await sleep(wait);
        continue;
      }
      const contentType = res.headers.get('content-type') ?? '';
      const isHtml = contentType.includes('text/html');
      const html = isHtml ? await readHead(res, maxBodyBytes) : '';
      if (!isHtml) await res.body?.cancel?.().catch(() => {});
      return { finalUrl: res.url, httpStatus: res.status, html };
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
