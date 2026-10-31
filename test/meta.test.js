import { describe, expect, it } from 'vitest';
import { decodeEntities, extractMeta, resourceUrl } from '../src/normalize/normalizer.js';
import { readBytes } from '../src/normalize/fetcher.js';
import { MEDIA_TYPES, mediaOf, sourceOf } from '../src/media/kinds.js';

const page = (head, lang = 'fr') => `<!doctype html><html lang="${lang}"><head>${head}</head><body></body></html>`;

describe('extractMeta', () => {
  it('lit aperçu, description, type, site et langue, URLs résolues contre la page', () => {
    const meta = extractMeta(
      page(`
        <meta property="og:title" content="Titre OG">
        <meta property="og:description" content="Une forêt d&eacute;crite &#8212; en d&#xE9;tail">
        <meta name="description" content="ignorée : og:description passe avant">
        <meta property="og:image" content="/img/a.jpg?x=1&amp;y=2">
        <meta property="og:type" content="video.other">
        <meta property='og:site_name' content='Site'>
      `, 'fr-FR'),
      'https://ex.com/p/q',
    );
    expect(meta).toEqual({
      title: 'Titre OG',
      description: 'Une forêt décrite — en détail',
      image: 'https://ex.com/img/a.jpg?x=1&y=2',
      ogType: 'video.other',
      siteName: 'Site',
      lang: 'fr-fr',
      icon: 'https://ex.com/favicon.ico',
    });
  });

  it('se replie sur description, twitter:image, et préfère og:image:secure_url', () => {
    expect(extractMeta(page('<meta name="description" content="  a\n b "><meta name="twitter:image" content="https://cdn.ex/t.png">'), 'https://ex.com/')).toMatchObject({
      description: 'a b',
      image: 'https://cdn.ex/t.png',
    });
    expect(
      extractMeta(page('<meta property="og:image" content="http://ex.com/a.jpg"><meta property="og:image:secure_url" content="https://ex.com/a.jpg">'), 'https://ex.com/').image,
    ).toBe('https://ex.com/a.jpg');
  });

  it("refuse les schémas autres que http(s) et borne les longueurs", () => {
    const meta = extractMeta(
      page(`<meta property="og:image" content="javascript:alert(1)"><meta name="description" content="${'x'.repeat(900)}">`),
      'https://ex.com/',
    );
    expect(meta.image).toBeNull();
    expect(meta.description).toHaveLength(500);
    expect(extractMeta(page(`<meta property="og:image" content="https://ex.com/${'a'.repeat(2100)}">`), 'https://ex.com/').image).toBeNull();
  });

  it("choisit l'icône : apple-touch-icon, puis PNG, puis autre ; jamais un SVG", () => {
    const icons = (links) => extractMeta(page(links), 'https://ex.com/a/').icon;
    expect(icons('<link rel="icon" href="f.ico"><link rel="icon" type="image/png" href="/f.png"><link rel="apple-touch-icon" href="/t.png">')).toBe('https://ex.com/t.png');
    expect(icons('<link rel="shortcut icon" href="/f.ico"><link rel="icon" href="/f-32.png">')).toBe('https://ex.com/f-32.png');
    expect(icons('<link rel="shortcut icon" href="/f.ico">')).toBe('https://ex.com/f.ico');
    expect(icons('<link rel="icon" href="/f.svg" type="image/svg+xml">')).toBe('https://ex.com/favicon.ico');
    expect(icons('<link rel="stylesheet" href="/s.css">')).toBe('https://ex.com/favicon.ico');
  });

  it('se contente d’un HTML pauvre', () => {
    expect(extractMeta('<title>x</title>', 'https://ex.com/')).toEqual({
      title: null, description: null, image: null, ogType: null, siteName: null, lang: null, icon: 'https://ex.com/favicon.ico',
    });
  });
});

describe('entités et URLs de ressource', () => {
  it('décode entités nommées et numériques, garde les inconnues', () => {
    expect(decodeEntities('&Eacute;t&eacute; &amp; &#233;&#x2014; &bogus; &#0; &#xFFFFFFF;')).toBe('Été & é— &bogus; &#0; &#xFFFFFFF;');
  });

  it('résout et filtre', () => {
    expect(resourceUrl('', 'https://ex.com/')).toBeNull();
    expect(resourceUrl('//cdn.ex/a.png', 'https://ex.com/')).toBe('https://cdn.ex/a.png');
    expect(resourceUrl('data:image/png;base64,xx', 'https://ex.com/')).toBeNull();
    expect(resourceUrl('http://[bad', 'https://ex.com/')).toBeNull();
  });
});

describe('readBytes', () => {
  const response = (chunks, headers = {}) =>
    new Response(new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(new Uint8Array(x))); c.close(); } }), { headers });

  it('lit le corps entier sous la limite', async () => {
    expect([...(await readBytes(response([[1, 2], [3]]), 10))]).toEqual([1, 2, 3]);
  });

  it('refuse un corps trop volumineux, déclaré ou constaté', async () => {
    await expect(readBytes(response([[1]], { 'content-length': '99' }), 10)).rejects.toThrow('trop volumineux : 99 octets (max 10)');
    await expect(readBytes(response([[1, 2, 3], [4, 5, 6]]), 4)).rejects.toMatchObject({ retryable: false });
  });

  it('lit une réponse sans flux', async () => {
    const res = { headers: new Headers(), arrayBuffer: async () => new Uint8Array([7]).buffer };
    expect([...(await readBytes(res, 10))]).toEqual([7]);
  });
});

describe('kinds', () => {
  it('donne la priorité au type déclaré par la réponse', () => {
    expect(mediaOf('https://ex.com/a', { contentType: 'application/pdf' })).toBe('pdf');
    expect(mediaOf('https://ex.com/a', { contentType: 'image/jpeg' })).toBe('image');
    expect(mediaOf('https://ex.com/a', { contentType: 'video/mp4' })).toBe('video');
    expect(mediaOf('https://ex.com/a', { contentType: 'text/csv; charset=utf-8' })).toBe('data');
    expect(mediaOf('https://ex.com/a', { contentType: 'text/html', ogType: 'video.movie' })).toBe('video');
    expect(mediaOf('https://ex.com/a.pdf', { contentType: 'text/html' })).toBe('pdf');
  });

  it("déduit le type de l'URL", () => {
    const cases = {
      'https://x.org/a/photo.JPG': 'image',
      'https://x.org/w.safetensors': 'model',
      'https://x.org/clip.webm': 'video',
      'https://x.org/d.parquet': 'data',
      'https://www.youtube.com/watch?v=1': 'video',
      'https://huggingface.co/a/b': 'model',
      'https://huggingface.co/datasets/a/b': 'data',
      'https://huggingface.co/spaces/a/b': 'code',
      'https://civitai.com/models/1': 'model',
      'https://gitlab.com/a/b': 'code',
      'https://www.kaggle.com/datasets/a/b': 'data',
      'https://zenodo.org/records/1': 'data',
      'https://www.pexels.com/photo/x-1/': 'image',
      'https://example.com/': 'page',
      'pas une url': 'page',
    };
    for (const [url, media] of Object.entries(cases)) expect([url, mediaOf(url)]).toEqual([url, media]);
    expect(Object.values(cases).every((m) => MEDIA_TYPES.includes(m))).toBe(true);
  });

  it('range un domaine dans sa famille de source', () => {
    expect(sourceOf('journals.plos.org')).toBe('research');
    expect(sourceOf('WWW.Europeana.eu')).toBe('archives');
    expect(sourceOf('notplos.org')).toBe('other');
    expect(sourceOf(null)).toBe('other');
  });
});
