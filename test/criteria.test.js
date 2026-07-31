import { describe, expect, it } from 'vitest';
import { buildPoolQuery } from '../src/pools/criteria.js';

describe('buildPoolQuery', () => {
  it('filtre toujours sur les URLs classées', () => {
    const { text } = buildPoolQuery({});
    expect(text).toContain("ui.status = 'classified'");
  });

  it('traduit thème principal, sous-thèmes et facettes en EXISTS paramétrés', () => {
    const { text, values } = buildPoolQuery({
      theme: 'ia-generative',
      subthemes: ['lora-training'],
      facets: { 'content-type': 'tutoriel' },
    });
    expect(text).toContain('ut.is_primary');
    expect(values).toContain('ia-generative');
    expect(values).toContainEqual(['lora-training']);
    expect(values).toContain('content-type');
    expect(values).toContain('tutoriel');
    expect(text).not.toContain('ia-generative'); // aucune valeur inline : tout est paramétré
  });

  it('applique seuils, domaines et limite', () => {
    const { text, values } = buildPoolQuery({
      min_relevance: 0.3,
      min_quality: 0.5,
      domains_exclude: ['pinterest.com'],
      limit: 10,
    });
    expect(text).toContain('ui.relevance_score >=');
    expect(text).toContain('ui.quality_score >=');
    expect(text).toContain('NOT (ui.domain = ANY');
    expect(values).toContain(10);
  });

  it('borne la limite à [1, 1000]', () => {
    expect(buildPoolQuery({ limit: 99999 }).values).toContain(1000);
    expect(buildPoolQuery({ limit: 0 }).values).toContain(1);
  });

  it("n'accepte que des ordres connus (liste blanche)", () => {
    expect(buildPoolQuery({ order: 'quality' }).text).toContain('ui.quality_score DESC');
    expect(() => buildPoolQuery({ order: 'id; DROP TABLE pool' })).toThrow(/Ordre inconnu/);
  });

  it('rejette les critères inconnus', () => {
    expect(() => buildPoolQuery({ foo: 1 })).toThrow(/Critère inconnu/);
  });
});
