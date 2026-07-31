// US-05 — classifieur par règles, fonctions pures (aucune I/O).
// Entrée : une URL normalisée + ses requêtes sources. Sortie : thème principal,
// sous-thèmes, facettes (une valeur par facette) et scores [0..1].

function countHits(haystack, keywords) {
  let hits = 0;
  for (const kw of keywords ?? []) {
    if (haystack.includes(kw.toLowerCase())) hits += 1;
  }
  return hits;
}

function scoreThemes(haystack, themes) {
  return themes.map((theme) => {
    const children = (theme.children ?? []).map((child) => ({
      slug: child.slug,
      score: countHits(haystack, child.keywords),
    }));
    const childScore = children.reduce((sum, c) => sum + c.score, 0);
    return {
      slug: theme.slug,
      ownScore: countHits(haystack, theme.keywords),
      score: countHits(haystack, theme.keywords) + childScore * 0.5,
      children,
    };
  });
}

function pickFacets(haystack, facets) {
  const result = {};
  for (const facet of facets ?? []) {
    let picked = null;
    let fallback = null;
    for (const { value, patterns } of facet.values) {
      if (patterns.length === 0) {
        fallback ??= value;
        continue;
      }
      if (patterns.some((p) => haystack.includes(p.toLowerCase()))) {
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
      .filter((t) => t.length > 2),
  );
  if (terms.size === 0) return 0;
  let matched = 0;
  for (const term of terms) {
    if (haystack.includes(term)) matched += 1;
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
  const haystack = [canonicalUrl, domain, title ?? '', ...(queries ?? [])]
    .join(' ')
    .toLowerCase();

  const scored = scoreThemes(haystack, taxonomy.themes ?? []);
  const ranked = [...scored].sort((a, b) => b.score - a.score);
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
    facets: pickFacets(haystack, taxonomy.facets),
    scores: {
      relevance: round3(relevanceScore(haystack, queries ?? [])),
      confidence: round3(confidence),
      quality: round3(qualityScore({ canonicalUrl, domain, title }, taxonomy)),
    },
  };
}
