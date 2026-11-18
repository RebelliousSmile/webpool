import { describe, expect, it } from 'vitest';
import { parseLinkText } from '../src/requests/links.js';

describe('lecture d’une liste de liens', () => {
  it('texte : URL puis titre ; commentaires, lignes vides, doublons', () => {
    const r = parseLinkText(['# Japon', '', 'https://a.jp/x Temple de Kyoto', 'https://b.jp', 'https://a.jp/x', 'pas une url'].join('\n'));
    expect(r.links).toEqual([
      { url: 'https://a.jp/x', title: 'Temple de Kyoto' },
      { url: 'https://b.jp', title: null },
    ]);
    expect(r).toMatchObject({ duplicates: 1, rejected: [{ line: 6, text: 'pas une url' }] });
  });

  it('Markdown : liens [titre](url), puces, plusieurs liens par ligne', () => {
    const r = parseLinkText(['## Sources', '- [Photo AC](https://www.photo-ac.com/) gratuit', '* https://unsplash.com/s/photos/kyoto Kyoto', '1. [A](https://a.jp) et [B](https://b.jp)'].join('\n'));
    expect(r.links.map((l) => [l.url, l.title])).toEqual([
      ['https://www.photo-ac.com/', 'Photo AC'],
      ['https://unsplash.com/s/photos/kyoto', 'Kyoto'],
      ['https://a.jp', 'A'],
      ['https://b.jp', 'B'],
    ]);
  });

  it('CSV et TSV : colonne URL détectée, en-tête ignoré, guillemets', () => {
    const r = parseLinkText(['url,titre', 'https://a.jp,"Temple, Kyoto"', '"Nagasaki";https://b.jp', 'C\thttps://c.jp'].join('\n'));
    expect(r.links.map((l) => [l.url, l.title])).toEqual([
      ['https://a.jp', 'Temple, Kyoto'],
      ['https://b.jp', 'Nagasaki'],
      ['https://c.jp', 'C'],
    ]);
    expect(r.rejected).toEqual([]);
  });

  it('favoris HTML : href http(s) seulement, titres sans balises, entités décodées', () => {
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><A HREF="https://a.jp/?q=1&amp;r=2" ADD_DATE="1">Kyoto <b>temples</b></A>
      <DT><A HREF="javascript:alert(1)">x</A><DT><a href='https://b.jp'>B &amp; co</a></DL>`;
    expect(parseLinkText(html).links).toEqual([
      { url: 'https://a.jp/?q=1&r=2', title: 'Kyoto temples' },
      { url: 'https://b.jp', title: 'B & co' },
    ]);
  });

  it('refuse les URL non http et trop longues', () => {
    const r = parseLinkText(['ftp://a.jp', `https://a.jp/${'x'.repeat(2000)}`, '- [x](https://ok.jp)'].join('\n'));
    expect(r.links).toEqual([{ url: 'https://ok.jp', title: 'x' }]);
    expect(r.rejected.map((x) => x.line)).toEqual([1, 2]);
  });
});
