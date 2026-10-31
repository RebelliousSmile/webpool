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

  it('include_requests : sélection normale, puis URLs des recherches de la communauté ; seuils toujours', () => {
    const def = { theme: 'ia-generative', min_quality: 0.4, domains_exclude: ['pinterest.com'], include_requests: true };
    const { text, values } = buildPoolQuery(def, { poolId: 7 });
    expect(text).toMatch(/^WITH base AS/);
    expect(text).toMatch(/extra AS[\s\S]*ui\.id IN \(SELECT us\.url_item_id FROM url_source us/);
    expect(text).toMatch(/JOIN community_pool cp ON cp\.community_id = w\.community_id/);
    expect(text).toContain('ui.id NOT IN (SELECT id FROM base)');
    expect(text).toMatch(/ORDER BY part, rn$/);
    expect(text).not.toContain('OR EXISTS');
    // seuil et exclusion dans les deux parties ; le thème seulement dans la base
    expect(text.match(/ui\.quality_score >= /g)).toHaveLength(2);
    expect(text.match(/NOT \(ui\.domain = ANY/g)).toHaveLength(2);
    expect(text.match(/ut\.is_primary/g)).toHaveLength(1);
    expect(values).toContain(7);
    // chaque $n référencé a sa valeur
    const max = Math.max(...[...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    expect(max).toBe(values.length);
    // sans pool connu (validation à la création) ou sans critère de sujet : requête simple
    expect(buildPoolQuery(def).text).not.toContain('search_request');
    const bare = buildPoolQuery({ include_requests: true }, { poolId: 7 });
    expect(bare.text).not.toContain('search_request');
    expect(bare.values).not.toContain(7);
    expect(() => buildPoolQuery({ include_requests: 'oui' })).toThrow(/include_requests invalide : un booléen/);
  });

  it('borne la limite à [1, 1000]', () => {
    expect(buildPoolQuery({ limit: 99999 }).values).toContain(1000);
    expect(buildPoolQuery({ limit: 0 }).values).toContain(1);
  });

  it("n'accepte que des ordres connus (liste blanche)", () => {
    expect(buildPoolQuery({ order: 'quality' }).text).toContain('ui.quality_score DESC');
    expect(() => buildPoolQuery({ order: 'id; DROP TABLE pool' })).toThrow(/Ordre inconnu/);
    expect(() => buildPoolQuery({ order: 'rare' })).toThrow(/attendu : quality, relevance, recent, composite, rarity/);
  });

  it('rarity : jointure du nombre d’URLs par domaine, ajoutée pour cet ordre seulement', () => {
    const { text } = buildPoolQuery({ order: 'rarity' });
    expect(text).toContain("LEFT JOIN (SELECT domain, count(*) AS urls FROM url_item");
    expect(text).toContain("status <> 'duplicate'");
    expect(text).toContain('1 / sqrt(coalesce(dc.urls, 1)) AS pool_score');
    expect(text).toContain('ORDER BY 1 / sqrt(coalesce(dc.urls, 1)) DESC, ui.quality_score DESC NULLS LAST, ui.id');
    expect(buildPoolQuery({ order: 'quality' }).text).not.toContain('LEFT JOIN');
  });

  it('recent : score lisible décroissant avec l’âge, ordre par découverte', () => {
    const { text } = buildPoolQuery({ order: 'recent' });
    expect(text).toContain('ORDER BY ui.first_seen_at DESC, ui.id');
    expect(text).not.toMatch(/\b0 AS pool_score/);
  });

  it('rejette les critères inconnus', () => {
    expect(() => buildPoolQuery({ foo: 1 })).toThrow(/Critère inconnu/);
  });

  it('valide le type de chaque critère en le nommant', () => {
    expect(() => buildPoolQuery({ limit: 'abc' })).toThrow(/Critère limit invalide/);
    expect(() => buildPoolQuery({ limit: 2.5 })).toThrow(/Critère limit invalide/);
    expect(() => buildPoolQuery({ subthemes: 'x' })).toThrow(/Critère subthemes invalide/);
    expect(() => buildPoolQuery({ theme: 42 })).toThrow(/Critère theme invalide/);
    expect(() => buildPoolQuery({ facets: ['a'] })).toThrow(/Critère facets invalide/);
    expect(() => buildPoolQuery({ facets: { type: 1 } })).toThrow(/Critère facets invalide/);
    expect(() => buildPoolQuery({ min_quality: 1.5 })).toThrow(/Critère min_quality invalide/);
    expect(() => buildPoolQuery({ min_relevance: '0.3' })).toThrow(/Critère min_relevance invalide/);
    expect(() => buildPoolQuery({ domains_exclude: [1] })).toThrow(/Critère domains_exclude invalide/);
  });

  it("rejette une définition qui n'est pas un objet", () => {
    expect(() => buildPoolQuery([])).toThrow(/objet JSON attendu/);
    expect(() => buildPoolQuery(null)).toThrow(/objet JSON attendu/);
  });

  it("n'accepte pas un ordre hérité du prototype", () => {
    expect(() => buildPoolQuery({ order: 'toString' })).toThrow(/Ordre inconnu/);
  });
});
