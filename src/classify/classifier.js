// US-05 — classifieur par règles, fonctions pures (aucune I/O).
// Entrée : une URL normalisée + ses requêtes sources. Sortie : thème principal,
// sous-thèmes, facettes (une valeur par facette) et scores [0..1].

// Un mot-clé ne correspond qu'en début de mot (`ui` ne trouve pas `build`,
// `app.` pas `whatsapp.com`) ; aucune frontière de fin : les mots-clés sont des
// racines (`photo` trouve `photography`, `tool` trouve `tools`).
// Le chinois et le japonais s'écrivent sans espaces : un mot-clé qui commence par
// un caractère han, hiragana ou katakana n'a pas de début de mot à exiger (写真
// doit être trouvé dans 風景写真). Le coréen sépare ses mots et garde la règle.
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const UNSPACED = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function compileKeyword(keyword) {
  const kw = keyword.toLowerCase();
  const start = /^[\p{L}\p{N}]/u.test(kw) && !UNSPACED.test(kw) ? '(?<![\\p{L}\\p{N}])' : '';
  return new RegExp(start + escapeRegExp(kw), 'u');
}

// Compilation une fois par liste de la taxonomie, pas à chaque item.
const compiled = new WeakMap();
function matchers(keywords) {
  if (!keywords) return [];
  let list = compiled.get(keywords);
  if (!list) {
    list = keywords.map(compileKeyword);
    compiled.set(keywords, list);
  }
  return list;
}

function countHits(haystack, keywords) {
  return matchers(keywords).filter((re) => re.test(haystack)).length;
}

// US-08 : le contenu propre de l'URL (url, domaine, titre) pèse plein pot ; les
// requêtes qui l'ont découverte ne comptent que pour QUERY_WEIGHT, afin qu'une
// URL n'hérite pas mécaniquement du thème de sa requête.
export const QUERY_WEIGHT = 0.25;

function weightedHits({ own, query }, keywords) {
  return countHits(own, keywords) + QUERY_WEIGHT * countHits(query, keywords);
}

function scoreThemes(text, themes) {
  return themes.map((theme) => {
    const children = (theme.children ?? []).map((child) => ({
      slug: child.slug,
      score: weightedHits(text, child.keywords),
    }));
    const childScore = children.reduce((sum, c) => sum + c.score, 0);
    return {
      slug: theme.slug,
      ownScore: countHits(text.own, theme.keywords),
      score: weightedHits(text, theme.keywords) + childScore * 0.5,
      children,
    };
  });
}

// Départage déterministe, indépendant de l'ordre de déclaration de la taxonomie :
// score, puis score issu du contenu propre, puis slug.
function compareThemes(a, b) {
  return b.score - a.score || b.ownScore - a.ownScore || a.slug.localeCompare(b.slug);
}

// US-08 : les facettes décrivent l'URL elle-même ; seul son contenu propre
// (url, domaine, titre) les décide, jamais la requête qui l'a trouvée.
function pickFacets(own, facets) {
  const result = {};
  for (const facet of facets ?? []) {
    let picked = null;
    let fallback = null;
    for (const { value, patterns } of facet.values) {
      if (patterns.length === 0) {
        fallback ??= value;
        continue;
      }
      if (matchers(patterns).some((re) => re.test(own))) {
        picked = value;
        break;
      }
    }
    const value = picked ?? fallback;
    if (value) result[facet.slug] = value;
  }
  return result;
}

function relevanceScore(haystack, queries) {
  const terms = new Set(
    queries
      .flatMap((q) => q.toLowerCase().split(/[^\p{L}\p{N}]+/u))
      // un terme CJK de 2 caractères (長崎, 写真) porte autant de sens qu'un mot latin
      .filter((t) => t.length > (CJK.test(t) ? 1 : 2)),
  );
  if (terms.size === 0) return 0;
  let matched = 0;
  for (const term of terms) {
    if (compileKeyword(term).test(haystack)) matched += 1;
  }
  return matched / terms.size;
}

function qualityScore({ canonicalUrl, domain, title }, taxonomy) {
  const url = new URL(canonicalUrl);
  let score = 0.5;
  if (url.protocol === 'https:') score += 0.2;
  if (title) score += 0.1;
  if ((taxonomy.quality_domains ?? []).includes(domain)) score += 0.1;
  const depth = url.pathname.split('/').filter(Boolean).length;
  if (depth > 4) score -= 0.1;
  if (url.search !== '') score -= 0.1;
  return Math.min(1, Math.max(0, score));
}

const round3 = (n) => Math.round(n * 1000) / 1000;

export function classifyItem({ canonicalUrl, domain, title, queries }, taxonomy) {
  const own = [canonicalUrl, domain, title ?? ''].join(' ').toLowerCase();
  const queryText = (queries ?? []).join(' ').toLowerCase();

  const scored = scoreThemes({ own, query: queryText }, taxonomy.themes ?? []);
  const ranked = [...scored].sort(compareThemes);
  const best = ranked[0];
  const second = ranked[1];

  const hasTheme = best && best.score > 0;
  const primary = hasTheme ? best.slug : null;
  const subthemes = hasTheme
    ? best.children.filter((c) => c.score > 0).map((c) => ({ slug: c.slug, score: c.score }))
    : [];

  const confidence = !hasTheme
    ? 0
    : second && second.score > 0
      ? (best.score - second.score) / best.score
      : 1;

  return {
    primary,
    primaryScore: hasTheme ? best.score : 0,
    subthemes,
    facets: pickFacets(own, taxonomy.facets),
    scores: {
      // termes des requêtes retrouvés dans le contenu propre : chercher aussi dans
      // les requêtes elles-mêmes donnerait 1 à toute URL découverte
      relevance: round3(relevanceScore(own, queries ?? [])),
      confidence: round3(confidence),
      quality: round3(qualityScore({ canonicalUrl, domain, title }, taxonomy)),
    },
  };
}
