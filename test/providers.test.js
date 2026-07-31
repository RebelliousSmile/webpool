import { describe, expect, it } from 'vitest';
import { normalizeResults } from '../src/ingest/providers/file.js';

describe('provider file — normalizeResults', () => {
  it('accepte un tableau de chaînes', () => {
    const res = normalizeResults(['https://a.com', 'https://b.com']);
    expect(res).toEqual([
      { url: 'https://a.com', rank: 1, title: null },
      { url: 'https://b.com', rank: 2, title: null },
    ]);
  });

  it("accepte un tableau d'objets et {results: []}", () => {
    const res = normalizeResults({
      results: [{ url: 'https://a.com', title: 'A' }, { autre: true }],
    });
    expect(res).toEqual([{ url: 'https://a.com', rank: 1, title: 'A' }]);
  });

  it('rejette les formats inattendus', () => {
    expect(() => normalizeResults({ nope: [] })).toThrow(/Format inattendu/);
  });
});
