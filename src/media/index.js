import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { query } from '../db.js';
import { withRun } from '../run.js';
import { createFetcher, mapLimit, readBytes, HttpError } from '../normalize/fetcher.js';
import { makeImage } from './thumbnail.js';

// `webpool media` : télécharge les vignettes et favicons en attente, les réduit
// en WebP et les range par empreinte dans le cache (config.mediaDir). Un échec
// marque l'élément `failed` avec son erreur, sans arrêter le lot.

// IP publique fixe : un `fetchImpl` injecté (tests) ne doit déclencher aucune résolution DNS.
const fakePublicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

// Réponse d'image : 2xx et Content-Type image/* (ou octet-stream, fréquent pour
// les .ico), corps borné.
async function readImage(res, maxBytes) {
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!/^(image\/|application\/octet-stream)/.test(type) && type !== '') {
    await res.body?.cancel?.().catch(() => {});
    throw Object.assign(new Error(`pas une image : ${type.split(';')[0]}`), { retryable: false });
  }
  return { bytes: await readBytes(res, maxBytes), contentType: type };
}

export function createImageFetcher({ fetchImpl, maxBytes = config.mediaMaxBytes, ...rest } = {}) {
  return createFetcher({
    ...(fetchImpl ? { fetchImpl, lookup: fakePublicLookup, perHostDelayMs: 0, backoffMs: 0 } : {}),
    ...rest,
    maxBodyBytes: maxBytes,
    accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
    read: readImage,
  });
}

// Écrit le fichier s'il n'existe pas déjà (même empreinte = même contenu).
async function store(dir, image) {
  const target = path.join(dir, image.file);
  try {
    await fs.writeFile(target, image.data, { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

async function download(fetcher, url, kind, dir) {
  const page = await fetcher(url);
  if (page.httpStatus >= 300) throw new HttpError(page.httpStatus);
  const image = await makeImage(page.bytes, kind);
  await store(dir, image);
  return image;
}

const errorText = (err) => String(err?.message ?? err).slice(0, 500);

export async function cacheMedia({
  limit = 200,
  retryFailed = false,
  dir = config.mediaDir,
  concurrency = config.mediaConcurrency,
  fetchImpl,
  fetcher = createImageFetcher({ fetchImpl }),
} = {}) {
  await fs.mkdir(dir, { recursive: true });
  return withRun('media', { limit, retryFailed }, async () => {
    if (retryFailed) {
      await query("UPDATE url_media SET status = 'pending', error = NULL WHERE status = 'failed'");
      await query("UPDATE domain_profile SET favicon_status = 'pending', favicon_error = NULL WHERE favicon_status = 'failed'");
    }
    // Seules les URL vivantes : un doublon ou une erreur n'est jamais affiché.
    const { rows: thumbs } = await query(
      `SELECT m.url_item_id, m.kind, m.source_url FROM url_media m
         JOIN url_item ui ON ui.id = m.url_item_id AND ui.status IN ('normalized', 'classified')
        WHERE m.status = 'pending'
        ORDER BY m.url_item_id, m.kind LIMIT $1`,
      [limit],
    );
    const { rows: icons } = await query(
      `SELECT domain, favicon_source FROM domain_profile
        WHERE favicon_status = 'pending' AND favicon_source IS NOT NULL
        ORDER BY domain LIMIT $1`,
      [limit],
    );

    const counts = { thumbs: 0, favicons: 0, failed: 0 };
    const results = await mapLimit(thumbs, concurrency, (t) => download(fetcher, t.source_url, 'thumb', dir));
    for (const [i, t] of thumbs.entries()) {
      const { value: img, error } = results[i];
      if (img) counts.thumbs += 1;
      else counts.failed += 1;
      await query(
        `UPDATE url_media SET status = $3, file = $4, width = $5, height = $6, bytes = $7, error = $8, fetched_at = now()
          WHERE url_item_id = $1 AND kind = $2`,
        img
          ? [t.url_item_id, t.kind, 'cached', img.file, img.width, img.height, img.bytes, null]
          : [t.url_item_id, t.kind, 'failed', null, null, null, null, errorText(error)],
      );
    }

    const iconResults = await mapLimit(icons, concurrency, (d) => download(fetcher, d.favicon_source, 'favicon', dir));
    for (const [i, d] of icons.entries()) {
      const { value: img, error } = iconResults[i];
      if (img) counts.favicons += 1;
      else counts.failed += 1;
      await query(
        `UPDATE domain_profile SET favicon_status = $2, favicon_file = $3, favicon_error = $4, favicon_fetched_at = now()
          WHERE domain = $1`,
        img ? [d.domain, 'cached', img.file, null] : [d.domain, 'failed', null, errorText(error)],
      );
    }
    return { ...counts, total: thumbs.length + icons.length };
  });
}
