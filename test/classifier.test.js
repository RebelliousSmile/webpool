import { describe, expect, it } from 'vitest';
import { classifyItem, compileKeyword } from '../src/classify/classifier.js';

const taxonomy = {
  themes: [
    {
      slug: 'ia-generative',
      label: 'IA générative',
      keywords: ['stable diffusion', 'lora', 'comfyui'],
      children: [
        { slug: 'lora-training', label: 'Entraînement LoRA', keywords: ['lora training', 'kohya'] },
      ],
    },
    {
      slug: 'photographie',
      label: 'Photographie',
      keywords: ['photo', 'unsplash'],
      children: [],
    },
  ],
  facets: [
    {
      slug: 'content-type',
      label: 'Type de contenu',
      values: [
        { value: 'video', patterns: ['youtube.com'] },
        { value: 'tutoriel', patterns: ['tutorial', 'guide'] },
        { value: 'article', patterns: [] },
      ],
    },
  ],
  quality_domains: ['unsplash.com'],
};

const item = (over = {}) => ({
  canonicalUrl: 'https://example.com/lora-training-guide',
  domain: 'example.com',
  title: 'LoRA training with kohya — complete guide',
  queries: ['lora training guide'],
  ...over,
});

describe('classifyItem', () => {
  it('attribue le thème principal et les sous-thèmes', () => {
    const res = classifyItem(item(), taxonomy);
    expect(res.primary).toBe('ia-generative');
    expect(res.subthemes.map((s) => s.slug)).toContain('lora-training');
  });

  it('attribue une valeur unique par facette, avec fallback', () => {
    const res = classifyItem(item(), taxonomy);
    expect(res.facets['content-type']).toBe('tutoriel');

    const fallback = classifyItem(
      item({ canonicalUrl: 'https://example.com/lora', title: 'lora', queries: [] }),
      taxonomy,
    );
    expect(fallback.facets['content-type']).toBe('article');
  });

  it('calcule des scores bornés [0..1]', () => {
    const res = classifyItem(item(), taxonomy);
    for (const score of Object.values(res.scores)) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
    expect(res.scores.relevance).toBe(1);
  });

  it('mesure la pertinence sur le contenu propre, pas sur la requête', () => {
    const res = classifyItem(
      item({ canonicalUrl: 'https://www.lemonde.fr/pixels/', domain: 'lemonde.fr', title: 'Pixels — Le Monde', queries: ['lora dataset captioning'] }),
      taxonomy,
    );
    expect(res.scores.relevance).toBe(0);
  });

  it('retourne primary null et confidence 0 sans correspondance', () => {
    const res = classifyItem(
      item({
        canonicalUrl: 'https://autre.org/cuisine',
        domain: 'autre.org',
        title: 'Recettes de cuisine',
        queries: ['recettes'],
      }),
      taxonomy,
    );
    expect(res.primary).toBeNull();
    expect(res.scores.confidence).toBe(0);
  });

  it('confidence vaut 1 quand un seul thème matche', () => {
    const res = classifyItem(
      item({
        canonicalUrl: 'https://unsplash.com/photos/foret',
        domain: 'unsplash.com',
        title: 'Photo de forêt',
        queries: ['photo forêt'],
      }),
      taxonomy,
    );
    expect(res.primary).toBe('photographie');
    expect(res.scores.confidence).toBe(1);
    expect(res.scores.quality).toBeGreaterThan(0.5);
  });

  describe('biais des requêtes sources (US-08)', () => {
    const heritage = {
      ...taxonomy,
      themes: [
        ...taxonomy.themes,
        { slug: 'patrimoine', label: 'Patrimoine', keywords: ['europeana', 'museum'], children: [] },
      ],
    };
    const europeana = {
      canonicalUrl: 'https://europeana.eu/en/collections/topic/190-art',
      domain: 'europeana.eu',
      title: 'Art — Europeana',
      queries: ['forest lora'],
    };

    it('le contenu propre prime sur la requête (cas Europeana)', () => {
      expect(classifyItem(europeana, heritage).primary).toBe('patrimoine');
    });

    it("le résultat ne dépend pas de l'ordre de déclaration de la taxonomie", () => {
      const reversed = { ...heritage, themes: [...heritage.themes].reverse() };
      expect(classifyItem(europeana, reversed).primary).toBe('patrimoine');
    });

    it('une égalité parfaite est départagée par slug, pas par ordre de déclaration', () => {
      const tie = {
        canonicalUrl: 'https://x.org/',
        domain: 'x.org',
        title: 'lora museum',
        queries: [],
      };
      const a = classifyItem(tie, heritage).primary;
      const b = classifyItem(tie, { ...heritage, themes: [...heritage.themes].reverse() }).primary;
      expect(a).toBe(b);
      expect(a).toBe('ia-generative');
    });

    it('une requête seule suffit encore à thématiser une URL sans indice propre', () => {
      const res = classifyItem(
        { canonicalUrl: 'https://x.org/a', domain: 'x.org', title: null, queries: ['stable diffusion'] },
        taxonomy,
      );
      expect(res.primary).toBe('ia-generative');
    });
  });

  describe('écritures CJK', () => {
    const jp = (title, queries) =>
      classifyItem(
        { canonicalUrl: 'https://example.jp/a', domain: 'example.jp', title, queries },
        taxonomy,
      );

    it('garde les termes de 2 caractères et les trouve sans espaces', () => {
      expect(jp('長崎の風景写真', ['長崎 写真 フリー素材']).scores.relevance).toBe(0.667);
      expect(jp('京都の寺', ['京都 写真素材']).scores.relevance).toBe(0.5);
    });

    it('reconnaît un mot-clé de la taxonomie au milieu d\'un texte japonais', () => {
      const tax = { ...taxonomy, themes: [{ slug: 'photo-jp', label: 'Photo', keywords: ['写真'], children: [] }] };
      const res = classifyItem(
        { canonicalUrl: 'https://example.jp/a', domain: 'example.jp', title: '長崎の風景写真', queries: [] },
        tax,
      );
      expect(res.primary).toBe('photo-jp');
    });

    it('garde le début de mot pour le latin et le coréen', () => {
      expect(compileKeyword('ui').test('build')).toBe(false);
      expect(compileKeyword('사진').test('풍경사진')).toBe(false);
      expect(compileKeyword('사진').test('풍경 사진')).toBe(true);
    });

    it('ignore toujours les termes latins de 2 caractères', () => {
      expect(jp('de la photo', ['de la photo']).scores.relevance).toBe(1);
      expect(jp('photo', ['de la photo']).scores.relevance).toBe(1);
    });
  });
});
