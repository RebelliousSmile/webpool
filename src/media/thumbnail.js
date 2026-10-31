import crypto from 'node:crypto';
import sharp from 'sharp';

// Réduction d'images non fiables en WebP. Seuls les formats raster connus
// passent ; le SVG (scriptable, rendu par une autre bibliothèque) est refusé,
// comme toute image de plus de MAX_PIXELS (bombe de décompression).

export const MAX_PIXELS = 40_000_000;
const RASTER = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'tiff', 'heif']);
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
    throw new ImageRefusedError('image illisible');
  }
  if (!RASTER.has(meta.format)) throw new ImageRefusedError(`format refusé : ${meta.format}`);
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
