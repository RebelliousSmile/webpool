// Exclusion des domaines saturés — fonctions pures (aucune I/O) : quels
// domaines écarter d'une requête, et comment, sans dépasser la longueur sûre.
import { createHash } from 'node:crypto';

// Saturé : plus de `threshold` URLs, ou exclu à la main ; les plus gros d'abord,
// pour qu'une troncature garde ceux qui pèsent le plus sur les résultats.
export function saturatedDomains(rows, threshold) {
  return rows
    .filter((r) => r.excluded || r.urls > threshold)
    .sort((a, b) => b.urls - a.urls || a.domain.localeCompare(b.domain))
    .map((r) => r.domain);
}

// Domaines visés par un `site:` positif de la requête (un `-site:` n'en est pas un).
export function targetedSites(query) {
  return [...query.matchAll(/(?:^|\s)site:(\S+)/gi)].map((m) => m[1].toLowerCase().replace(/^www\./, ''));
}

const related = (a, b) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

// Suffixe `-site:` ajouté tant que la requête reste sous `maxChars` ; la requête
// d'origine n'est jamais coupée. `hash` est null quand rien n'est exclu.
export function applyExclusion(query, domains, maxChars) {
  const targeted = targetedSites(query);
  const excluded = [];
  let sent = query;
  for (const domain of domains) {
    if (targeted.some((t) => related(t, domain))) continue;
    const next = `${sent} -site:${domain}`;
    if (next.length > maxChars) break;
    sent = next;
    excluded.push(domain);
  }
  return { query: sent, excluded, hash: exclusionHash(excluded) };
}

export function exclusionHash(domains) {
  return domains.length ? createHash('sha1').update(domains.join('\n')).digest('hex') : null;
}
