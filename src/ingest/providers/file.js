import fs from 'node:fs';

// Provider hors-ligne : lit un export JSON de résultats de recherche.
// Formats acceptés : ["https://…", …] · [{url, rank?, title?}, …] · {results: [...]}
export function normalizeResults(data) {
  const list = Array.isArray(data) ? data : data?.results;
  if (!Array.isArray(list)) {
    throw new Error('Format inattendu : tableau ou {results: []} requis');
  }
  return list
    .map((entry, i) => {
      if (typeof entry === 'string') return { url: entry, rank: i + 1, title: null };
      if (entry && typeof entry.url === 'string') {
        return { url: entry.url, rank: entry.rank ?? i + 1, title: entry.title ?? null };
      }
      return null;
    })
    .filter(Boolean);
}

export async function search({ input }) {
  if (!input) throw new Error('Provider file : option --input <fichier.json> requise');
  const data = JSON.parse(fs.readFileSync(input, 'utf8'));
  return normalizeResults(data);
}
