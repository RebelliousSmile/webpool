import { describe, expect, it } from 'vitest';
import { formatPool, toCsv, toJson, toMarkdown } from '../src/pools/export.js';

const data = {
  pool: { slug: 'p', label: 'Mon pool', definition: { theme: 'ia-generative' }, refreshed_at: '2026-10-23T10:00:00Z' },
  items: [
    { rank: 1, score: '0.9', canonical_url: 'https://a.com/x', domain: 'a.com', title: 'Titre, "cité"' },
    { rank: 2, score: 0.5, canonical_url: 'https://b.com/(y)', domain: 'b.com', title: '=HYPERLINK("evil")' },
    { rank: 3, score: 0.1, canonical_url: 'https://c.com/', domain: 'c.com', title: null },
  ],
};

describe('export de pool', () => {
  it('JSON : inclut la définition, respecte le rang', () => {
    const out = JSON.parse(toJson(data));
    expect(out.pool.definition).toEqual({ theme: 'ia-generative' });
    expect(out.pool.count).toBe(3);
    expect(out.items.map((i) => i.rank)).toEqual([1, 2, 3]);
    expect(out.items[0]).toEqual({ rank: 1, url: 'https://a.com/x', domain: 'a.com', title: 'Titre, "cité"', score: 0.9 });
  });

  it('CSV : échappe guillemets/virgules et neutralise les formules', () => {
    const lines = toCsv(data).trimEnd().split('\n');
    expect(lines[0]).toBe('rank,url,domain,title,score');
    expect(lines[1]).toBe('1,https://a.com/x,a.com,"Titre, ""cité""",0.900');
    expect(lines[2]).toContain("\"'=HYPERLINK(\"\"evil\"\")\"");
    expect(lines[3]).toBe('3,https://c.com/,c.com,,0.100');
  });

  it('Markdown : tableau lié, pipes et parenthèses échappés', () => {
    const md = toMarkdown({ ...data, items: [{ ...data.items[1], title: 'a|b' }] });
    expect(md).toContain('[a\\|b](https://b.com/(y%29)');
    expect(md).toContain('# Mon pool');
  });

  it('rejette un format inconnu', () => {
    expect(() => formatPool(data, 'xml')).toThrow(/Format inconnu/);
  });
});
