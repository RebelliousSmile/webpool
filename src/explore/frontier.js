// Frontière d'exploration — fonctions pures (aucune I/O) : quelle requête
// relancer, à quelle page, et quand l'abandonner.

// Dernière page interrogeable par provider (Brave : offset 0 à 9).
const MAX_PAGE = { brave: 9 };
const DEFAULT_MAX_PAGE = 9;

export function maxPage(provider) {
  return MAX_PAGE[provider] ?? DEFAULT_MAX_PAGE;
}

// Moyenne amortie des domaines nouveaux par passage : le +1 au dénominateur
// évite qu'un seul passage chanceux place une requête devant une requête
// régulière. Une requête jamais lancée passe avant toutes les autres.
export function priority({ runs = 0, newDomains = 0 }) {
  if (runs === 0) return Infinity;
  return newDomains / (runs + 1);
}

// Ordre stable : priorité, puis la requête la moins récemment lancée, puis l'id.
export function selectQueries(candidates, budget) {
  const time = (d) => (d ? new Date(d).getTime() : 0);
  return [...candidates]
    .map((q) => ({ ...q, priority: priority(q) }))
    .sort(
      (a, b) =>
        (a.priority === b.priority ? 0 : b.priority > a.priority ? 1 : -1) ||
        time(a.lastRunAt) - time(b.lastRunAt) ||
        a.id - b.id,
    )
    .slice(0, budget);
}

// État après un passage réussi sur `page` : la page avance ; la requête est
// épuisée après la dernière page ou après `dryRunsLimit` passages sans URL nouvelle.
export function nextState({ provider, page, newUrls, dryRuns = 0, dryRunsLimit }) {
  const dry = newUrls > 0 ? 0 : dryRuns + 1;
  const next = page + 1;
  const exhausted = next > maxPage(provider) || dry >= dryRunsLimit;
  return { nextPage: next, dryRuns: dry, exhausted };
}

// Une requête épuisée revient, depuis la page 0, après `restDays` jours.
export function isRested(exhaustedAt, now, restDays) {
  if (!exhaustedAt) return true;
  return now.getTime() - new Date(exhaustedAt).getTime() >= restDays * 86_400_000;
}
