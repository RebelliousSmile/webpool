import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSchema, dbAvailable, dbRequired, dropSchema, resetData, writeTempJson } from './helpers.js';

const available = await dbAvailable();
if (!available && dbRequired()) {
  throw new Error('[integration] PostgreSQL injoignable alors que la suite est requise (CI ou WEBPOOL_IT_REQUIRED).');
}

// Le cache vit dans un dossier jetable ; l'API le lit via config.mediaDir.
const MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'webpool-media-'));
process.env.WEBPOOL_MEDIA_DIR = MEDIA_DIR;

const image = (w, h, format = 'png') =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 40, g: 90, b: 140 } } })[format]().toBuffer();

describe.skipIf(!available)('médias des liens sur PostgreSQL', () => {
  let db;
  let mod;
  let site;
  const calls = [];

  // Faux réseau : pages HTML, images, refus.
  const fetchImpl = async (url) => {
    calls.push(url);
    const r = site[url];
    if (!r) return new Response('absent', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(r.body, { status: 200, headers: { 'content-type': r.type, ...(r.headers ?? {}) } });
  };
  const html = (head) => `<html lang="fr"><head>${head}</head><body></body></html>`;
  const q = (...a) => db.query(...a);

  beforeAll(async () => {
    await createSchema();
    db = await import('../../src/db.js');
    await resetData(q);
    mod = {
      ...(await import('../../src/ingest/index.js')),
      ...(await import('../../src/normalize/index.js')),
      ...(await import('../../src/classify/index.js')),
      ...(await import('../../src/media/index.js')),
      pools: await import('../../src/pools/index.js'),
      clients: await import('../../src/api/clients.js'),
      api: await import('../../src/api/index.js'),
      server: await import('../../src/api/server.js'),
    };
    site = {
      'https://site.example/page': {
        type: 'text/html; charset=utf-8',
        body: html(`<title>LoRA forêt</title>
          <meta property="og:image" content="/og.png"><meta name="description" content="Guide d&#8217;entra&icirc;nement">
          <meta property="og:site_name" content="Site"><link rel="apple-touch-icon" href="/icon.png">`),
      },
      'https://site.example/og.png': { type: 'image/png', body: await image(900, 600) },
      'https://site.example/icon.png': { type: 'image/png', body: await image(180, 180) },
      'https://img.example/photo.jpg': { type: 'image/jpeg', body: await image(640, 480, 'jpeg') },
      'https://noog.example/a': { type: 'text/html', body: html('<title>Sans aperçu</title>') },
      'https://cdn.example/t.png': { type: 'image/png', body: await image(300, 200) },
      'https://bad.example/p': { type: 'text/html', body: html('<meta property="og:image" content="/x.svg">') },
      'https://bad.example/x.svg': {
        type: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
      },
      'https://big.example/p': { type: 'text/html', body: html('<meta property="og:image" content="/big.png">') },
      'https://big.example/big.png': { type: 'image/png', body: 'x', headers: { 'content-length': String(50 * 1024 * 1024) } },
      'https://video.example/v': { type: 'text/html', body: html('<meta property="og:type" content="video.other">') },
    };
    site['https://noog.example/a?utm_source=x'] = site['https://noog.example/a'];
    const input = writeTempJson('serp.json', [
      { url: 'https://site.example/page', title: 'LoRA forêt' },
      { url: 'https://img.example/photo.jpg', title: 'Photo' },
      { url: 'https://noog.example/a', title: 'Sans aperçu', thumbnail: 'https://cdn.example/t.png' },
      { url: 'https://bad.example/p', title: 'SVG' },
      { url: 'https://big.example/p', title: 'Énorme' },
      { url: 'https://video.example/v', title: 'Vidéo' },
      // variante de noog.example/a : devient un doublon et cède sa vignette fournie
      { url: 'https://noog.example/a?utm_source=x', title: 'Variante', thumbnail: 'https://cdn.example/other.png' },
      { url: 'javascript:alert(1)', title: 'Refusée', thumbnail: 'ftp://x/y.png' },
    ]);
    await mod.ingest({ provider: 'file', searchQuery: 'forêt', input });
    await mod.normalizePending({ fetchImpl });
  });

  afterAll(async () => {
    await db?.closePool();
    await dropSchema();
    fs.rmSync(MEDIA_DIR, { recursive: true, force: true });
  });

  const item = async (url) =>
    (await q('SELECT * FROM url_item WHERE canonical_url = $1 AND status <> $2', [url, 'duplicate'])).rows[0];

  it('un doublon cède ses vignettes à la survivante, sans écraser les siennes', async () => {
    const { rows } = await q("SELECT count(*)::int AS n FROM url_item WHERE status = 'duplicate'");
    expect(rows[0].n).toBe(1);
    const { rows: orphans } = await q(
      `SELECT count(*)::int AS n FROM url_media m JOIN url_item ui ON ui.id = m.url_item_id WHERE ui.status = 'duplicate'`,
    );
    expect(orphans[0].n).toBe(0);
  });

  it('la normalisation lit description, type, langue, site, aperçu et icône', async () => {
    const page = await item('https://site.example/page');
    expect(page).toMatchObject({ description: 'Guide d’entraînement', media_type: 'page', lang: 'fr', site_name: 'Site' });
    expect((await item('https://img.example/photo.jpg')).media_type).toBe('image');
    expect((await item('https://video.example/v')).media_type).toBe('video');
    const { rows: media } = await q('SELECT ui.canonical_url, m.kind, m.source_url FROM url_media m JOIN url_item ui ON ui.id = m.url_item_id ORDER BY 1, 2');
    expect(media.map((m) => [m.canonical_url, m.kind, m.source_url])).toEqual([
      ['https://bad.example/p', 'og', 'https://bad.example/x.svg'],
      ['https://big.example/p', 'og', 'https://big.example/big.png'],
      ['https://img.example/photo.jpg', 'og', 'https://img.example/photo.jpg'],
      ['https://noog.example/a', 'provider', 'https://cdn.example/t.png'],
      ['https://site.example/page', 'og', 'https://site.example/og.png'],
    ]);
    const { rows: icons } = await q('SELECT domain, favicon_source FROM domain_profile WHERE favicon_source IS NOT NULL ORDER BY domain');
    expect(Object.fromEntries(icons.map((d) => [d.domain, d.favicon_source]))).toMatchObject({
      'site.example': 'https://site.example/icon.png',
      'noog.example': 'https://noog.example/favicon.ico',
    });
  });

  it('webpool media réduit, range par empreinte et trace les refus', async () => {
    const res = await mod.cacheMedia({ fetchImpl, dir: MEDIA_DIR });
    expect(res).toMatchObject({ thumbs: 3, failed: expect.any(Number) });
    const { rows } = await q(
      `SELECT ui.canonical_url, m.status, m.file, m.width, m.height, m.error FROM url_media m
         JOIN url_item ui ON ui.id = m.url_item_id ORDER BY 1`,
    );
    const by = Object.fromEntries(rows.map((r) => [r.canonical_url, r]));
    expect(by['https://site.example/page']).toMatchObject({ status: 'cached', width: 480, height: 320 });
    expect(by['https://noog.example/a']).toMatchObject({ status: 'cached', width: 300 });
    expect(by['https://bad.example/p']).toMatchObject({ status: 'failed', error: 'format refusé : svg' });
    expect(by['https://big.example/p'].error).toMatch(/^trop volumineux/);
    expect(fs.existsSync(path.join(MEDIA_DIR, by['https://site.example/page'].file))).toBe(true);
    const { rows: icons } = await q('SELECT domain, favicon_status, favicon_error FROM domain_profile WHERE favicon_status IS NOT NULL ORDER BY domain');
    const icon = Object.fromEntries(icons.map((d) => [d.domain, d]));
    expect(icon['site.example'].favicon_status).toBe('cached');
    expect(icon['noog.example']).toMatchObject({ favicon_status: 'failed', favicon_error: 'HTTP 404' });
    // rien en attente : un second passage ne télécharge rien
    const before = calls.length;
    expect(await mod.cacheMedia({ fetchImpl, dir: MEDIA_DIR })).toMatchObject({ total: 0 });
    expect(calls.length).toBe(before);
  });

  it('--retry-failed remet les échecs en attente', async () => {
    const res = await mod.cacheMedia({ fetchImpl, dir: MEDIA_DIR, retryFailed: true });
    expect(res.total).toBeGreaterThan(0);
    expect(res.thumbs + res.favicons).toBe(0);
  });

  it("l'API expose type, source, description, vignette et favicon, et sert le fichier", async () => {
    await mod.classifyPending({});
    await mod.pools.createPool({ slug: 'tout', label: 'Tout', definition: { limit: 100 } });
    await mod.pools.refreshPool('tout');
    const reader = await mod.clients.addClient({ name: 'lecteur' });
    await mod.clients.setPoolAccess({ name: 'lecteur', slug: 'tout', granted: true });
    const server = mod.server.createApiServer({ routes: mod.api.routes, authenticate: mod.clients.authenticate });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const res = await fetch(`${base}/api/v1/pools/tout/items`, { headers: { Authorization: `Bearer ${reader.token}` } });
      const items = (await res.json()).items;
      const page = items.find((i) => i.url === 'https://site.example/page');
      expect(page).toMatchObject({
        description: 'Guide d’entraînement',
        media_type: 'page',
        source: 'other',
        thumbnail: expect.stringMatching(/^\/api\/v1\/media\/[0-9a-f]{32}\.webp$/),
        favicon: expect.stringMatching(/^\/api\/v1\/media\/[0-9a-f]{32}\.webp$/),
      });
      expect(items.find((i) => i.url === 'https://bad.example/p')).toMatchObject({ thumbnail: null, favicon: null });
      expect(items.find((i) => i.url === 'https://noog.example/a').thumbnail).not.toBeNull();

      const file = await fetch(`${base}${page.thumbnail}`);
      expect(file.status).toBe(200);
      expect(file.headers.get('content-type')).toBe('image/webp');
      expect(file.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect((await sharp(Buffer.from(await file.arrayBuffer())).metadata()).width).toBe(480);
      for (const bad of ['0'.repeat(32) + '.webp', '..%2F..%2Fetc%2Fpasswd', 'x.webp']) {
        expect((await fetch(`${base}/api/v1/media/${bad}`)).status).toBe(404);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('une nouvelle source d’aperçu relance le téléchargement, la même ne change rien', async () => {
    const id = (await item('https://site.example/page')).id;
    await q("UPDATE url_item SET status = 'pending' WHERE id = $1", [id]);
    await mod.normalizePending({ fetchImpl });
    expect((await q("SELECT status FROM url_media WHERE url_item_id = $1 AND kind = 'og'", [id])).rows[0].status).toBe('cached');
    site['https://site.example/page'].body = html('<meta property="og:image" content="/og2.png">');
    await q("UPDATE url_item SET status = 'pending' WHERE id = $1", [id]);
    await mod.normalizePending({ fetchImpl });
    expect((await q("SELECT status, source_url FROM url_media WHERE url_item_id = $1 AND kind = 'og'", [id])).rows[0]).toEqual({
      status: 'pending',
      source_url: 'https://site.example/og2.png',
    });
  });
});
