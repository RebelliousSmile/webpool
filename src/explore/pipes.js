// Tuyaux d'exploration — fonctions pures (aucune I/O). Un tuyau est un sujet,
// déclaré par l'étiquette `flot:<slug>` de ses requêtes ; sa pression est le
// nombre de domaines nouveaux bien notés par appel. L'exploration se concentre
// sur un tuyau, passe au suivant quand sa pression baisse par rapport à son
// départ, et revient au premier après le dernier.

export const DEFAULT_PIPE = 'defaut';
const PREFIX = 'flot:';

export function pipeOf(tags = []) {
  const tag = tags.find((t) => t.startsWith(PREFIX) && t.length > PREFIX.length);
  return tag ? tag.slice(PREFIX.length) : DEFAULT_PIPE;
}

// Ordre de première apparition : id de requête le plus petit de chaque tuyau.
export function pipeOrder(queries) {
  const first = new Map();
  for (const q of [...queries].sort((a, b) => a.id - b.id)) {
    const slug = pipeOf(q.tags);
    if (!first.has(slug)) first.set(slug, q.id);
  }
  return [...first.keys()];
}

// Domaines bien notés par appel ; `null` sans appel.
export function pressure(runs) {
  if (runs.length === 0) return null;
  return runs.reduce((acc, r) => acc + r.goodDomains, 0) / runs.length;
}

// `runs` : appels réussis de la visite, dans l'ordre. Seuls les appels jugés
// (plus aucune URL en attente de classement) comptent. Référence : les `window`
// premiers ; pression courante : les `window` derniers.
export function visitPressures(runs, window) {
  const judged = runs.filter((r) => r.judged);
  if (judged.length < window) return { reference: null, pressure: null, judged: judged.length };
  return {
    reference: pressure(judged.slice(0, window)),
    pressure: pressure(judged.slice(-window)),
    judged: judged.length,
  };
}

// Un tuyau sans requête active est quitté ; sinon seulement sur une pression
// connue, inférieure ou égale à `dropRatio` × référence (un tuyau stérile, à
// référence et pression nulles, est donc quitté).
export function shouldSwitch({ reference, pressure: current, dropRatio, activeQueries }) {
  if (activeQueries === 0) return true;
  if (reference === null || current === null) return false;
  return current <= dropRatio * reference;
}

// Tuyau suivant dans l'ordre circulaire, `current` lui-même en dernier recours ;
// les tuyaux de `skip` sont sautés. `null` si aucun ne reste.
export function nextPipe(order, current, skip = new Set()) {
  const start = order.indexOf(current);
  for (let i = 1; i <= order.length; i += 1) {
    const slug = order[(start + i) % order.length];
    if (!skip.has(slug)) return slug;
  }
  return null;
}
