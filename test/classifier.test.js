import { describe, expect, it } from 'vitest';
import { classifyItem } from '../src/classify/classifier.js';

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
});
