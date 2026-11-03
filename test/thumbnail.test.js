import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_FORMATS,
  ImageRefusedError,
  MEDIA_FILE_RE,
  acceptedFormat,
  icoLargestPng,
  makeImage,
  sniffRefusedFormat,
} from '../src/media/thumbnail.js';

const png = (width, height) =>
  sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 60 } } }).png().toBuffer();

// Fichier .ico d'une entrée (taille déclarée `side`, 0 = 256 px).
function ico(entries) {
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ side, data }, i) => {
    const at = 6 + i * 16;
    header[at] = side;
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.data)]);
}

describe('makeImage', () => {
  it('réduit une vignette à 480 px de large, proportions gardées, en WebP nommé par empreinte', async () => {
    const out = await makeImage(await png(1200, 600));
    expect(out).toMatchObject({ width: 480, height: 240 });
    expect(out.file).toMatch(MEDIA_FILE_RE);
    expect((await sharp(out.data).metadata()).format).toBe('webp');
    expect((await makeImage(await png(1200, 600))).file).toBe(out.file);
  });

  it("n'agrandit pas une petite image et accepte le JPEG", async () => {
    const jpeg = await sharp(await png(200, 100)).jpeg().toBuffer();
    expect(await makeImage(jpeg)).toMatchObject({ width: 200, height: 100 });
  });

  it('met un favicon au carré de 64 px', async () => {
    expect(await makeImage(await png(180, 120), 'favicon')).toMatchObject({ width: 64, height: 64 });
  });

  it('extrait la plus grande entrée PNG d’un .ico', async () => {
    const small = await png(16, 16);
    const big = await png(48, 48);
    const file = ico([{ side: 16, data: small }, { side: 48, data: big }]);
    expect(icoLargestPng(file)).toEqual(big);
    expect(await makeImage(file, 'favicon')).toMatchObject({ width: 64 });
  });

  it('refuse SVG, .ico sans PNG, octets illisibles et image géante', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    await expect(makeImage(svg)).rejects.toThrow('format refusé : svg');
    const bmpIco = ico([{ side: 16, data: Buffer.from('BM' + 'x'.repeat(40)) }]);
    await expect(makeImage(bmpIco)).rejects.toThrow('icône .ico sans image PNG');
    await expect(makeImage(Buffer.from('pas une image'))).rejects.toBeInstanceOf(ImageRefusedError);
    await expect(makeImage(await png(7000, 7000))).rejects.toThrow('image trop grande');
  });

  it('ignore les entrées .ico tronquées ou mal placées', () => {
    const file = ico([{ side: 16, data: Buffer.alloc(4) }]);
    expect(icoLargestPng(file)).toBeNull();
    const truncated = Buffer.from(file.subarray(0, 10));
    truncated.writeUInt16LE(3, 4);
    expect(icoLargestPng(truncated)).toBeNull();
    expect(icoLargestPng(Buffer.from([1, 2]))).toBeNull();
  });
});

// Les encodeurs restent disponibles : seuls les décodeurs sont restreints.
const encode = (format) =>
  sharp({ create: { width: 16, height: 12, channels: 3, background: '#c33' } }).toFormat(format).toBuffer();

const XML_SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');

describe('makeImage — formats acceptés', () => {
  it('ne connaît que jpeg, png, webp, gif et avif', () => {
    expect(ACCEPTED_FORMATS).toEqual(['jpeg', 'png', 'webp', 'gif', 'avif']);
  });

  it.each(['jpeg', 'png', 'webp', 'gif', 'avif'])('réduit un %s en WebP', async (format) => {
    const out = await makeImage(await encode(format));
    expect(out.file).toMatch(MEDIA_FILE_RE);
    expect((await sharp(out.data).metadata()).format).toBe('webp');
  });

  it.each([
    ['tiff', () => encode('tiff')],
    ['svg', async () => XML_SVG],
  ])('refuse un %s', async (format, make) => {
    const err = await makeImage(await make()).catch((e) => e);
    expect(err).toBeInstanceOf(ImageRefusedError);
    expect(err.message).toBe(`format refusé : ${format}`);
  });

  it("refuse ce qu'aucun décodeur autorisé ne lit", async () => {
    await expect(makeImage(Buffer.from('%PDF-1.7\n'))).rejects.toThrow('format refusé : pdf');
    await expect(makeImage(Buffer.from('rien de lisible'))).rejects.toThrow('image illisible');
  });
});

describe('acceptedFormat', () => {
  it('distingue AVIF (AV1) et HEIC (HEVC), tous deux « heif » pour sharp', () => {
    expect(acceptedFormat({ format: 'heif', compression: 'av1' })).toBe('avif');
    expect(acceptedFormat({ format: 'heif', compression: 'hevc' })).toBeNull();
    expect(acceptedFormat({ format: 'tiff' })).toBeNull();
    expect(acceptedFormat({ format: 'svg' })).toBeNull();
    expect(acceptedFormat({ format: 'png' })).toBe('png');
  });
});

describe('sniffRefusedFormat', () => {
  it('reconnaît tiff, svg et pdf', () => {
    expect(sniffRefusedFormat(Buffer.from('II*\0rest'))).toBe('tiff');
    expect(sniffRefusedFormat(Buffer.from('MM\0*rest'))).toBe('tiff');
    expect(sniffRefusedFormat(XML_SVG)).toBe('svg');
    expect(sniffRefusedFormat(Buffer.from('  <!-- c --><svg>'))).toBe('svg');
    expect(sniffRefusedFormat(Buffer.from('%PDF-1.4'))).toBe('pdf');
    expect(sniffRefusedFormat(Buffer.from('GIF89a'))).toBeNull();
  });
});
