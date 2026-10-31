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

// Attributs d'une balise (`<meta property="og:image" content="…">`), noms en minuscules.
function attributes(tag) {
  const attrs = {};
  for (const m of tag.matchAll(/([a-zA-Z_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

// Entités nommées courantes (français compris) ; les entités numériques sont toutes décodées.
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â', ccedil: 'ç',
  icirc: 'î', iuml: 'ï', ocirc: 'ô', ucirc: 'û', ugrave: 'ù', uuml: 'ü', oelig: 'œ', Eacute: 'É',
};
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (code[0] !== '#') return ENTITIES[code] ?? ENTITIES[code.toLowerCase()] ?? all;
    const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });
}

const clean = (text, max) => {
  const s = decodeEntities(String(text ?? '')).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

// URL de ressource : résolue contre la page, http(s) seulement, longueur bornée.
export function resourceUrl(href, baseUrl) {
  if (!href) return null;
  try {
    const url = new URL(decodeEntities(href.trim()), baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const out = url.toString();
    return out.length <= 2000 ? out : null;
  } catch {
    return null;
  }
}

// Ordre de préférence des icônes : apple-touch-icon (PNG, grand), icône PNG,
// autre icône déclarée, puis /favicon.ico par convention.
function iconRank(rel, type, href) {
  if (/apple-touch-icon/.test(rel)) return 0;
  if (/png/.test(type) || /\.png(\?|$)/i.test(href)) return 1;
  if (/svg/.test(type) || /\.svg(\?|$)/i.test(href)) return 9; // refusé au téléchargement
  return 2;
}

// Métadonnées utiles d'une page : aperçu (og:image, twitter:image), description,
// type (og:type), nom du site, langue, icône. Fonction pure.
export function extractMeta(html, baseUrl) {
  const meta = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const a = attributes(tag);
    const key = (a.property ?? a.name ?? '').toLowerCase();
    if (key && a.content !== undefined && !(key in meta)) meta[key] = a.content;
  }
  let icon = null;
  let iconScore = Infinity;
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const a = attributes(tag);
    const rel = (a.rel ?? '').toLowerCase();
    if (!/(^|\s)(icon|shortcut icon|apple-touch-icon(-precomposed)?)(\s|$)/.test(rel) && rel !== 'shortcut icon') continue;
    const href = resourceUrl(a.href, baseUrl);
    const score = href ? iconRank(rel, (a.type ?? '').toLowerCase(), href) : Infinity;
    if (score < iconScore) {
      icon = href;
      iconScore = score;
    }
  }
  const lang = /<html\b[^>]*\blang\s*=\s*["']?([a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?)/i.exec(html)?.[1] ?? null;
  return {
    title: clean(meta['og:title'], 500),
    description: clean(meta['og:description'] ?? meta.description ?? meta['twitter:description'], 500),
    image: resourceUrl(meta['og:image:secure_url'] ?? meta['og:image'] ?? meta['twitter:image'] ?? meta['twitter:image:src'], baseUrl),
    ogType: clean(meta['og:type'], 50),
    siteName: clean(meta['og:site_name'], 200),
    lang: lang ? lang.toLowerCase() : null,
    icon: iconScore < 9 ? icon : resourceUrl('/favicon.ico', baseUrl),
  };
}
