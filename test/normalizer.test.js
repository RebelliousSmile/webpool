import { describe, expect, it } from 'vitest';
import {
  canonicalizeUrl,
  domainOf,
  extractCanonicalLink,
  extractTitle,
  isTrackingParam,
} from '../src/normalize/normalizer.js';

describe('isTrackingParam', () => {
  it('détecte les paramètres exacts et par préfixe', () => {
    expect(isTrackingParam('gclid')).toBe(true);
    expect(isTrackingParam('utm_source')).toBe(true);
    expect(isTrackingParam('UTM_CAMPAIGN')).toBe(true);
    expect(isTrackingParam('page')).toBe(false);
    expect(isTrackingParam('q')).toBe(false);
  });
});

describe('canonicalizeUrl', () => {
  it('retire les paramètres de tracking', () => {
    expect(
      canonicalizeUrl('https://example.com/article?utm_source=x&utm_medium=y&id=42&fbclid=abc'),
    ).toBe('https://example.com/article?id=42');
  });

  it('retire le fragment et le www., minuscule le host', () => {
    expect(canonicalizeUrl('https://WWW.Example.COM/Path#section')).toBe(
      'https://example.com/Path',
    );
  });

  it('trie les paramètres restants', () => {
    expect(canonicalizeUrl('https://example.com/p?b=2&a=1&c=3')).toBe(
      'https://example.com/p?a=1&b=2&c=3',
    );
  });

  it('retire le slash final sauf à la racine', () => {
    expect(canonicalizeUrl('https://example.com/dossier/')).toBe('https://example.com/dossier');
    expect(canonicalizeUrl('https://example.com/')).toBe('https://example.com/');
    expect(canonicalizeUrl('https://example.com')).toBe('https://example.com/');
  });

  it("ne laisse pas de '?' vide quand tous les paramètres sont du tracking", () => {
    expect(canonicalizeUrl('https://example.com/p?utm_source=x')).toBe('https://example.com/p');
  });

  it('rejette les schémas non http(s)', () => {
    expect(() => canonicalizeUrl('ftp://example.com/f')).toThrow(/Schéma/);
  });

  it('fait converger les variantes vers la même canonique (clé de dédup)', () => {
    const a = canonicalizeUrl('https://www.example.com/page/?utm_campaign=z');
    const b = canonicalizeUrl('https://example.com/page');
    expect(a).toBe(b);
    expect(domainOf(a)).toBe('example.com');
  });
});

describe('extractTitle', () => {
  it('extrait et nettoie le titre', () => {
    expect(extractTitle('<html><head><title>  Un\n  Titre </title></head></html>')).toBe(
      'Un Titre',
    );
  });
  it('retourne null sans titre', () => {
    expect(extractTitle('<html><body>rien</body></html>')).toBeNull();
  });
});

describe('extractCanonicalLink', () => {
  it('résout le lien canonical relatif contre la base', () => {
    const html = '<link rel="canonical" href="/vraie-page">';
    expect(extractCanonicalLink(html, 'https://example.com/variante?x=1')).toBe(
      'https://example.com/vraie-page',
    );
  });
  it('ignore les autres links', () => {
    const html = '<link rel="stylesheet" href="/style.css">';
    expect(extractCanonicalLink(html, 'https://example.com/')).toBeNull();
  });
});
