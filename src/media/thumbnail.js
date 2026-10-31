import crypto from 'node:crypto';
import sharp from 'sharp';

// Réduction d'images non fiables en WebP. Seuls jpeg, png, webp, gif et avif
// passent ; heif (HEVC), tiff et svg (scriptable, rendu par une autre
// bibliothèque) sont refusés, comme toute image de plus de MAX_PIXELS (bombe de
// décompression).

export const MAX_PIXELS = 40_000_000;
export const ACCEPTED_FORMATS = ['jpeg', 'png', 'webp', 'gif', 'avif'];

// Défense en profondeur : libvips ne garde que les décodeurs de ces formats
// (AVIF passe par celui de libheif). Tiff, svg, pdf, magick, jp2k, jxl… ne
// sont jamais appelés, même sur une image qui tromperait la détection.
// Réglage global du processus : sharp ne sert qu'ici.
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({
  operation: ['VipsForeignLoadJpeg', 'VipsForeignLoadPng', 'VipsForeignLoadWebp', 'VipsForeignLoadNsgif', 'VipsForeignLoadHeif'],
});

// Format retenu : sharp nomme `heif` un AVIF ; seul l'AV1 compte comme avif.
export function acceptedFormat(meta) {
  const format = meta.format === 'heif' && meta.compression === 'av1' ? 'avif' : meta.format;
  return ACCEPTED_FORMATS.includes(format) ? format : null;
}

// Nom d'un format refusé que libvips ne lit plus (décodeur bloqué), pour un
// message utile ; null si inconnu.
export function sniffRefusedFormat(buffer) {
  const head = buffer.subarray(0, 512).toString('latin1');
  if (/^(II\*\0|MM\0\*)/.test(head)) return 'tiff';
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg';
  if (/^%PDF-/.test(head)) return 'pdf';
  return null;
}
export const THUMB_WIDTH = 480;
export const FAVICON_SIZE = 64;

export class ImageRefusedError extends Error {}

const isIco = (buffer) => buffer.length >= 6 && buffer.readUInt16LE(0) === 0 && buffer.readUInt16LE(2) === 1;

// Un .ico est un répertoire d'images : on garde la plus grande entrée PNG (les
// icônes modernes en contiennent une). Une entrée BMP n'est pas prise en charge.
export function icoLargestPng(buffer) {
  if (!isIco(buffer)) return null;
  const count = buffer.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    if (at + 16 > buffer.length) break;
    const size = buffer.readUInt32LE(at + 8);
    const offset = buffer.readUInt32LE(at + 12);
    if (offset + size > buffer.length || size < 8) continue;
    const data = buffer.subarray(offset, offset + size);
    const isPng = data.readUInt32BE(0) === 0x89504e47;
    const side = buffer[at] || 256;
    if (isPng && (!best || side > best.side)) best = { side, data };
  }
  return best?.data ?? null;
}

async function decode(buffer) {
  if (isIco(buffer) && !icoLargestPng(buffer)) throw new ImageRefusedError('icône .ico sans image PNG');
  const input = icoLargestPng(buffer) ?? buffer;
  let meta;
  try {
    // metadata() ne lit que l'en-tête : la taille se vérifie avant tout décodage,
    // et le décodage reste plafonné par limitInputPixels.
    meta = await sharp(input, { limitInputPixels: false }).metadata();
  } catch {
    const refused = sniffRefusedFormat(input);
    throw new ImageRefusedError(refused ? `format refusé : ${refused}` : 'image illisible');
  }
  if (!acceptedFormat(meta)) throw new ImageRefusedError(`format refusé : ${meta.format}`);
  if ((meta.width ?? 0) * (meta.height ?? 0) > MAX_PIXELS) throw new ImageRefusedError('image trop grande');
  return input;
}

// Vignette : largeur THUMB_WIDTH au plus, proportions gardées ; favicon :
// carré FAVICON_SIZE. WebP sans métadonnées (sharp les retire par défaut).
// Le nom de fichier est l'empreinte du WebP produit.
export async function makeImage(buffer, kind = 'thumb') {
  const input = await decode(buffer);
  const pipeline = sharp(input, { limitInputPixels: MAX_PIXELS, animated: false }).rotate();
  const sized =
    kind === 'favicon'
      ? pipeline.resize(FAVICON_SIZE, FAVICON_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      : pipeline.resize({ width: THUMB_WIDTH, withoutEnlargement: true });
  const { data, info } = await sized.webp({ quality: kind === 'favicon' ? 90 : 72 }).toBuffer({ resolveWithObject: true });
  const file = `${crypto.createHash('sha256').update(data).digest('hex').slice(0, 32)}.webp`;
  return { data, file, width: info.width, height: info.height, bytes: data.length };
}

export { MEDIA_FILE_RE } from './files.js';
