// US-04 — fonctions pures de normalisation d'URL. Aucune I/O ici : testable en isolation.

const TRACKING_EXACT = new Set([
  'gclid', 'fbclid', 'msclkid', 'dclid', 'twclid', 'igshid', 'igsh',
  'mc_cid', 'mc_eid', 'yclid', 'wbraid', 'gbraid', 'si', 'spm',
  'ref_src', 'ref_url', '_ga', '_gl', 'srsltid', 'sca_esv', 'fbid',
]);
const TRACKING_PREFIXES = ['utm_', 'pk_', 'mtm_', 'hsa_', 'vero_', 'oly_'];

export function isTrackingParam(name) {
  const lower = name.toLowerCase();
  return TRACKING_EXACT.has(lower) || TRACKING_PREFIXES.some((p) => lower.startsWith(p));
}

// Canonise une URL : host minuscule sans www., fragment retiré, paramètres de
// tracking supprimés, paramètres restants triés, slash final retiré (hors racine).
export function canonicalizeUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Schéma non supporté : ${url.protocol}`);
  }

  url.hash = '';
  url.hostname = url.hostname.replace(/^www\./, '');

  const kept = [...url.searchParams.entries()].filter(([name]) => !isTrackingParam(name));
  kept.sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  url.search = '';
  for (const [name, value] of kept) url.searchParams.append(name, value);

  if (url.pathname !== '/' && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  let out = url.toString();
  // URL sérialise la racine avec un slash final : on garde ce comportement,
  // mais on retire un éventuel '?' vide résiduel.
  if (out.endsWith('?')) out = out.slice(0, -1);
  return out;
}

// Domaine de déduplication : hostname canonique (minuscule, sans www.).
export function domainOf(canonicalUrl) {
  return new URL(canonicalUrl).hostname;
}

export function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const title = m[1].replace(/\s+/g, ' ').trim();
  return title.length > 0 ? title.slice(0, 500) : null;
}

// <link rel="canonical" href="…"> déclaré par la page, résolu contre l'URL de base.
export function extractCanonicalLink(html, baseUrl) {
  const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of linkTags) {
    if (!/rel\s*=\s*["']?canonical["']?/i.test(tag)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!href) continue;
    try {
      return new URL(href[1], baseUrl).toString();
    } catch {
      return null;
    }
  }
  return null;
}
