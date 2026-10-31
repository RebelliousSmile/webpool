// US-12 — export d'un pool matérialisé vers un format consommable hors base.
// Les formateurs sont des fonctions pures (testables sans base).
// Variante `client` (clients read de l'API) : ni définition ni score, les
// critères de sélection restent internes.

export const FORMATS = ['json', 'csv', 'md', 'txt'];

export function toJson({ pool, items }, { client = false } = {}) {
  return `${JSON.stringify(
    {
      pool: {
        slug: pool.slug,
        label: pool.label,
        refreshed_at: pool.refreshed_at ? new Date(pool.refreshed_at).toISOString() : null,
        count: items.length,
        // Réexécutable : webpool pool create --slug <slug> --file <ce fichier extrait de .pool.definition>
        ...(client ? {} : { definition: pool.definition }),
      },
      items: items.map((it) => ({
        rank: it.rank,
        url: it.canonical_url,
        domain: it.domain,
        title: it.title ?? null,
        ...(client ? {} : { score: Number(it.score) }),
      })),
    },
    null,
    2,
  )}\n`;
}

// Les titres viennent du web : une cellule débutant par = + - @ serait évaluée
// comme formule par un tableur, on la neutralise par une apostrophe.
function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv({ items }, { client = false } = {}) {
  const lines = [client ? 'rank,url,domain,title' : 'rank,url,domain,title,score'];
  for (const it of items) {
    const cells = [it.rank, it.canonical_url, it.domain, it.title];
    if (!client) cells.push(Number(it.score).toFixed(3));
    lines.push(cells.map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// Les titres viennent du web : le HTML est échappé, un rendu Markdown n'exécute rien.
const escapeHtml = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const mdCell = (s) => escapeHtml(String(s ?? '')).replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();

export function toMarkdown({ pool, items }, { client = false } = {}) {
  const lines = [
    `# ${mdCell(pool.label)}`,
    '',
    `Pool \`${pool.slug}\` — ${items.length} URLs`,
    '',
    client ? '| # | Titre | Domaine |' : '| # | Titre | Domaine | Score |',
    client ? '|---|---|---|' : '|---|---|---|---|',
  ];
  for (const it of items) {
    const title = mdCell(it.title) || mdCell(it.canonical_url);
    const link = `[${title.replaceAll(']', '\\]')}](${it.canonical_url.replaceAll(')', '%29')})`;
    lines.push(`| ${it.rank} | ${link} | ${mdCell(it.domain)} |${client ? '' : ` ${Number(it.score).toFixed(3)} |`}`);
  }
  return `${lines.join('\n')}\n`;
}

// Une URL par ligne, dans l'ordre de rang : à coller dans un outil ou un script.
export function toTxt({ items }) {
  return items.map((it) => `${it.canonical_url}\n`).join('');
}

const FORMATTERS = { json: toJson, csv: toCsv, md: toMarkdown, txt: toTxt };

export function formatPool(data, format = 'json', options = {}) {
  const fn = FORMATTERS[format];
  if (!fn) throw new Error(`Format inconnu : ${format} (attendu : ${FORMATS.join(', ')})`);
  return fn(data, options);
}
