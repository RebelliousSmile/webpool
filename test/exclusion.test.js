import { describe, expect, it } from 'vitest';
import {
  applyExclusion,
  excludableDomains,
  exclusionHash,
  saturatedDomains,
  targetedSites,
} from '../src/explore/exclusion.js';

describe('exclusion — domaines saturés', () => {
  const rows = [
    { domain: 'pexels.com', urls: 60, excluded: false },
    { domain: 'rare.jp', urls: 3, excluded: false },
    { domain: 'unsplash.com', urls: 120, excluded: false },
    { domain: 'pinterest.com', urls: 0, excluded: true },
    { domain: 'seuil.com', urls: 50, excluded: false },
  ];

  it('au-delà du seuil ou exclus à la main, les plus gros d’abord', () => {
    expect(saturatedDomains(rows, 50)).toEqual(['unsplash.com', 'pexels.com', 'pinterest.com']);
  });
});

describe('exclusion — suffixe -site:', () => {
  it('ajoute les -site: dans l’ordre donné', () => {
    expect(applyExclusion('temple kyoto', ['a.com', 'b.com'], 400)).toMatchObject({
      query: 'temple kyoto -site:a.com -site:b.com',
      excluded: ['a.com', 'b.com'],
    });
  });

  it('tronque sous la longueur maximale en gardant les premiers, sans couper la requête', () => {
    const res = applyExclusion('temple kyoto', ['unsplash.com', 'pexels.com', 'x.com'], 40);
    expect(res.query).toBe('temple kyoto -site:unsplash.com');
    expect(res.query.length).toBeLessThanOrEqual(40);
    const long = 'q'.repeat(50);
    expect(applyExclusion(long, ['a.com'], 40)).toEqual({ query: long, excluded: [], hash: null });
  });

  it('n’exclut jamais un domaine visé par un site: de la requête', () => {
    expect(targetedSites('photo site:www.Unsplash.com -site:pexels.com')).toEqual(['unsplash.com']);
    const res = applyExclusion('photo site:unsplash.com', ['unsplash.com', 'images.unsplash.com', 'pexels.com'], 400);
    expect(res.excluded).toEqual(['pexels.com']);
  });

  it('hash stable, sensible à l’ensemble et à l’ordre, null si rien n’est exclu', () => {
    expect(exclusionHash(['a.com', 'b.com'])).toBe(exclusionHash(['a.com', 'b.com']));
    expect(exclusionHash(['a.com', 'b.com'])).not.toBe(exclusionHash(['a.com']));
    expect(exclusionHash(['a.com', 'b.com'])).toMatch(/^[0-9a-f]{40}$/);
    expect(exclusionHash([])).toBeNull();
  });
});

describe('exclusion — liste de domaines (OpenRouter)', () => {
  it('garde l’ordre et écarte les domaines visés par site:, sous-domaines compris', () => {
    expect(excludableDomains('photo site:unsplash.com', ['images.unsplash.com', 'pexels.com', 'unsplash.com'])).toEqual([
      'pexels.com',
    ]);
    expect(excludableDomains('photo', ['b.com', 'a.com'])).toEqual(['b.com', 'a.com']);
  });
});
