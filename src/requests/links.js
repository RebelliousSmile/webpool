// Lecture d'une liste de liens dans le format où elle existe — fonction pure,
// même algorithme que datapool (src/lib/billing.ts, parseLinkLines).
//
// - favoris HTML (export de navigateur) : chaque <a href="http…">titre</a> ;
// - Markdown : [titre](url) n'importe où dans la ligne, ou URL nue après une
//   puce (- * + ou 1.) ;
// - CSV ou TSV : la colonne http(s) est l'URL, la première autre colonne non
//   vide le titre ; une ligne d'en-tête (url, title…) est ignorée ;
// - texte : l'URL puis un titre facultatif.
// Lignes vides et commentaires (#) ignorés, doublons retirés. Rendu :
// { links: [{url, title}], rejected: [{line, text}], duplicates }.

const HTTP = /^https?:\/\//i;
const MD_LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi;
const HTML_LINK = /<a\s[^>]*href\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const HEADER = /^\s*"?(url|lien|link|href)"?\s*[,;\t]/i;

const decodeEntities = (t) =>
  t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const cleanTitle = (t) => (t ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300) || null;
const unquote = (f) => f.trim().replace(/^"(.*)"$/, '$1').replace(/""/g, '"').trim();

function validUrl(url) {
  if (url.length > 2000) return false;
  try {
    const p = new URL(url);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

export function parseLinkText(text) {
  const out = { links: [], rejected: [], duplicates: 0 };
  const seen = new Set();
  const push = (url, title) => {
    const u = decodeEntities(url.trim());
    if (seen.has(u)) {
      out.duplicates += 1;
      return true;
    }
    if (!validUrl(u)) return false;
    seen.add(u);
    out.links.push({ url: u, title: cleanTitle(title && decodeEntities(title)) });
    return true;
  };

  // Favoris HTML : les liens, où qu'ils soient.
  if (/<a\s[^>]*href/i.test(text)) {
    for (const m of text.matchAll(HTML_LINK)) push(m[1], m[2]);
    return out;
  }

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || HEADER.test(line)) return;
    const reject = () => out.rejected.push({ line: i + 1, text: line.slice(0, 120) });
    const md = [...line.matchAll(MD_LINK)];
    if (md.length) {
      for (const m of md) if (!push(m[2], m[1])) reject();
      return;
    }
    const fields = line.split(/\t|;|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(unquote);
    if (fields.length > 1 && fields.some((f) => HTTP.test(f))) {
      const url = fields.find((f) => HTTP.test(f));
      const title = fields.find((f) => f && f !== url);
      if (!push(url, title)) reject();
      return;
    }
    const [first, ...rest] = line.replace(/^([-*+]|\d+[.)])\s+/, '').split(/\s+/);
    if (!HTTP.test(first) || !push(first, rest.join(' '))) reject();
  });
  return out;
}
