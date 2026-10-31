// Type de média et famille de source d'un lien — fonctions pures. Le type se
// fixe à la normalisation (Content-Type, og:type, URL) ; la famille de source se
// calcule à la lecture depuis le domaine. Mêmes règles que datapool
// (src/lib/kinds.ts), qui s'en sert en repli pour les liens antérieurs.

export const MEDIA_TYPES = ['page', 'image', 'video', 'pdf', 'data', 'code', 'model'];
export const SOURCES = ['research', 'archives', 'stock', 'community', 'video', 'press', 'other'];

const SOURCE_DOMAINS = {
  research: [
    'plos.org', 'frontiersin.org', 'osf.io', 'nature.com', 'cairn.info', 'arxiv.org', 'hal.science',
    'pnas.org', 'elifesciences.org', 'sagepub.com', 'apa.org', 'cambridge.org', 'nejm.org',
    'researchgate.net', 'annualreviews.org', 'sciencedirect.com', 'springer.com', 'wiley.com',
    'biorxiv.org', 'ncbi.nlm.nih.gov', 'semanticscholar.org', 'jstor.org', 'persee.fr',
    'openedition.org', 'zenodo.org', 'bps.org.uk', 'santepubliquefrance.fr',
  ],
  archives: [
    'europeana.eu', 'commons.wikimedia.org', 'pastvu.com', 'hermitagemuseum.org', 'gallica.bnf.fr',
    'archive.org', 'loc.gov', 'rijksmuseum.nl', 'metmuseum.org', 'britishmuseum.org',
  ],
  stock: [
    'flickr.com', 'pexels.com', 'polyhaven.com', 'ambientcg.com', 'shutterstock.com', 'unsplash.com',
    'pixabay.com', 'gettyimages.com', 'stock.adobe.com', 'freepik.com', 'vecteezy.com',
  ],
  community: [
    'civitai.com', 'huggingface.co', 'github.com', 'gitlab.com', 'reddit.com', 'artstation.com',
    'deviantart.com', 'behance.net', 'stackoverflow.com', 'kaggle.com',
  ],
  video: ['youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com', 'twitch.tv'],
  press: [
    'theconversation.com', 'aeon.co', 'atlasobscura.com', 'wikipedia.org', 'medium.com', 'substack.com',
    'lemonde.fr', 'bbc.co.uk', 'theguardian.com', 'nytimes.com',
  ],
};

const within = (host, domain) => host === domain || host.endsWith(`.${domain}`);
const bareHost = (h) => String(h ?? '').toLowerCase().replace(/^www\./, '');

export function sourceOf(domain) {
  const host = bareHost(domain);
  for (const [source, domains] of Object.entries(SOURCE_DOMAINS)) {
    if (domains.some((d) => within(host, d))) return source;
  }
  return 'other';
}

const EXT = [
  [/\.pdf$/, 'pdf'],
  [/\.(jpe?g|png|gif|webp|avif|svg|tiff?|exr|hdr)$/, 'image'],
  [/\.(mp4|webm|mov|mkv)$/, 'video'],
  [/\.(csv|tsv|json|parquet|xlsx?|zip)$/, 'data'],
  [/\.(safetensors|ckpt|gguf|onnx)$/, 'model'],
];

const IMAGE_PAGES = [
  ['flickr.com', /^\/photos\/[^/]+\/\d/],
  ['unsplash.com', /^\/photos\//],
  ['pexels.com', /^\/photo\//],
  ['pixabay.com', /^\/(photos|illustrations|vectors)\//],
  ['commons.wikimedia.org', /^\/wiki\/file:/],
  ['polyhaven.com', /^\/a\//],
  ['ambientcg.com', /^\/view/],
];

// Type déclaré par la réponse : le Content-Type d'abord, puis og:type.
function declaredMedia(contentType, ogType) {
  const ct = String(contentType ?? '').toLowerCase();
  if (ct.startsWith('application/pdf')) return 'pdf';
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  if (/^(text\/csv|application\/(json|zip|vnd\.ms-excel|vnd\.openxmlformats))/.test(ct)) return 'data';
  const og = String(ogType ?? '').toLowerCase();
  if (og.startsWith('video')) return 'video';
  return null;
}

export function mediaOf(url, { contentType, ogType } = {}) {
  const declared = declaredMedia(contentType, ogType);
  if (declared) return declared;
  let host;
  let path;
  try {
    const u = new URL(url);
    host = bareHost(u.hostname);
    path = u.pathname.toLowerCase();
  } catch {
    return 'page';
  }
  for (const [re, media] of EXT) if (re.test(path)) return media;
  if (SOURCE_DOMAINS.video.some((d) => within(host, d))) return 'video';
  if (within(host, 'huggingface.co')) {
    return path.startsWith('/datasets/') ? 'data' : path.startsWith('/spaces/') ? 'code' : 'model';
  }
  if (within(host, 'civitai.com') && path.startsWith('/models')) return 'model';
  if (['github.com', 'gitlab.com', 'codeberg.org'].some((d) => within(host, d))) return 'code';
  if ((within(host, 'kaggle.com') && path.startsWith('/datasets')) || within(host, 'zenodo.org') || within(host, 'data.gouv.fr')) {
    return 'data';
  }
  if (IMAGE_PAGES.some(([d, re]) => within(host, d) && re.test(path))) return 'image';
  return 'page';
}
