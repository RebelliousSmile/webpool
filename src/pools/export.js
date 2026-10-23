// US-12 — export d'un pool matérialisé vers un format consommable hors base.
// Les formateurs sont des fonctions pures (testables sans base).

export const FORMATS = ['json', 'csv', 'md'];

export function toJson({ pool, items }) {
  return `${JSON.stringify(
    {
      pool: {
        slug: pool.slug,
        label: pool.label,
        refreshed_at: pool.refreshed_at ? new Date(pool.refreshed_at).toISOString() : null,
        count: items.length,
        // Réexécutable : webpool pool create --slug <slug> --file <ce fichier extrait de .pool.definition>
        definition: pool.definition,
      },
      items: items.map((it) => ({
        rank: it.rank,
        url: it.canonical_url,
        domain: it.domain,
        title: it.title ?? null,
        score: Number(it.score),
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

export function toCsv({ items }) {
  const lines = ['rank,url,domain,title,score'];
  for (const it of items) {
    lines.push(
      [it.rank, it.canonical_url, it.domain, it.title, Number(it.score).toFixed(3)]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

const mdCell = (s) => String(s ?? '').replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();

export function toMarkdown({ pool, items }) {
  const lines = [
    `# ${mdCell(pool.label)}`,
    '',
    `Pool \`${pool.slug}\` — ${items.length} URLs`,
    '',
    '| # | Titre | Domaine | Score |',
    '|---|---|---|---|',
  ];
  for (const it of items) {
    const title = mdCell(it.title) || it.canonical_url;
    lines.push(
      `| ${it.rank} | [${title.replaceAll(']', '\\]')}](${it.canonical_url.replaceAll(')', '%29')}) | ${mdCell(it.domain)} | ${Number(it.score).toFixed(3)} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

const FORMATTERS = { json: toJson, csv: toCsv, md: toMarkdown };

export function formatPool(data, format = 'json') {
  const fn = FORMATTERS[format];
  if (!fn) throw new Error(`Format inconnu : ${format} (attendu : ${FORMATS.join(', ')})`);
  return fn(data);
}
