// Non-régression sur la taxonomie réelle : faux positifs relevés pendant l'audit
// du 2026-10-30, et rappel des racines (pluriels, dérivés).
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyItem, compileKeyword } from '../src/classify/classifier.js';

const taxonomy = JSON.parse(fs.readFileSync(new URL('../config/taxonomy.json', import.meta.url), 'utf8'));

const classify = ({ url = 'https://example.org/page', title = '', queries = [] } = {}) =>
  classifyItem({ canonicalUrl: url, domain: new URL(url).hostname, title, queries }, taxonomy);

describe('taxonomie réelle — faux positifs', () => {
  it('« Quick build guide » n’est pas du design', () => {
    expect(classify({ title: 'Quick build guide' }).primary).not.toBe('design');
  });

  it('influxdata.com n’est pas du design', () => {
    expect(classify({ url: 'https://influxdata.com/' }).primary).not.toBe('design');
  });

  it('whatsapp.com n’est pas un outil', () => {
    expect(classify({ url: 'https://whatsapp.com/' }).facets['content-type']).not.toBe('outil');
  });

  it('la requête « forest guide » ne fait pas d’une URL neutre un tutoriel', () => {
    expect(classify({ queries: ['forest guide'] }).facets['content-type']).toBe('article');
  });
});

describe('taxonomie réelle — détections attendues', () => {
  it('app.example.com est un outil', () => {
    expect(classify({ url: 'https://app.example.com/' }).facets['content-type']).toBe('outil');
  });

  it('lieu : Gotō l’emporte sur Nagasaki, la requête ne décide pas', () => {
    expect(classify({ url: 'https://en.photo-ac.com/photo/1', title: 'Nagasaki / Goto Islands Fukue Island' }).facets.lieu).toBe('goto');
    expect(classify({ title: 'Kyoto temple', queries: ['Tokyo photos'] }).facets.lieu).toBe('kyoto');
    expect(classify({ title: 'Goat Island', queries: ['Goto Islands photos'] }).facets.lieu).toBe('autre');
  });

  it('unsplash.com : photographie, usage commercial libre', () => {
    const res = classify({ url: 'https://unsplash.com/photos/forest' });
    expect(res.primary).toBe('photographie');
    expect(res.facets['usage-commercial']).toBe('libre');
  });

  it('usage commercial : payant, sous conditions, à qualifier par défaut', () => {
    const usage = (opts) => classify(opts).facets['usage-commercial'];
    expect(usage({ url: 'https://www.shutterstock.com/search/kyoto' })).toBe('payant');
    expect(usage({ title: 'Licensed under Creative Commons BY-SA' })).toBe('sous-conditions');
    expect(usage({ url: 'https://blue-wind.net/kyoto' })).toBe('a-qualifier');
    expect(usage({ queries: ['unsplash kyoto'] })).toBe('a-qualifier');
  });

  it('youtube.com est une vidéo, docs. un tutoriel', () => {
    expect(classify({ url: 'https://youtube.com/watch?v=x' }).facets['content-type']).toBe('video');
    expect(classify({ url: 'https://docs.example.com/start' }).facets['content-type']).toBe('tutoriel');
  });

  it('les racines trouvent pluriels et dérivés', () => {
    expect(classify({ title: 'Photography tips' }).primary).toBe('photographie');
    expect(classify({ title: 'Free tools' }).facets['content-type']).toBe('outil');
    expect(classify({ title: 'Drawing tutorials' }).facets['content-type']).toBe('tutoriel');
    const vector = classify({ title: 'Vector illustrations' });
    expect(vector.primary).toBe('illustration');
    expect(vector.subthemes.map((s) => s.slug)).toContain('vector');
  });

  it('mot-clé multi-mots et domaine avec ponctuation', () => {
    const res = classify({ url: 'https://github.com/x/y', title: 'Concept Art tips' });
    expect(res.subthemes.map((s) => s.slug)).toContain('concept-art');
    expect(res.facets['content-type']).toBe('outil');
  });
});

describe('taxonomie réelle — pools thématiques', () => {
  it('un article frontiersin de 2025 : psychologie, publication, annee 2025', () => {
    const res = classify({
      url: 'https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2025.1523456/full',
      title: 'Emotion regulation and anxiety in adolescents: a longitudinal study',
    });
    expect(res.primary).toBe('psychologie');
    expect(res.facets['content-type']).toBe('publication');
    expect(res.facets.annee).toBe('2025');
  });

  it('un DOI est une publication ; sans année visible, pas de facette annee', () => {
    const res = classify({ url: 'https://doi.org/10.1037/xge0001234', title: 'Social behavior and cognition' });
    expect(res.facets['content-type']).toBe('publication');
    expect(res.facets.annee).toBeUndefined();
  });

  it('créatures : un kraken mutant est aquatique, une harpie ailée aérienne', () => {
    const eau = classify({ url: 'https://www.artstation.com/artwork/abc', title: 'Mutant Kraken - creature concept' });
    expect(eau.primary).toBe('illustration');
    expect(eau.subthemes.map((s) => s.slug)).toContain('creatures');
    expect(eau.facets.element).toBe('eau');
    const air = classify({ url: 'https://www.deviantart.com/x/art/1', title: 'Winged Harpy mutant creature' });
    expect(air.subthemes.map((s) => s.slug)).toContain('creatures');
    expect(air.facets.element).toBe('air');
  });

  it('Saint-Pétersbourg insolite, en latin et en cyrillique', () => {
    const atlas = classify({
      url: 'https://www.atlasobscura.com/things-to-do/saint-petersburg-russia',
      title: 'Unusual things to do in Saint Petersburg, Russia',
    });
    expect(atlas.primary).toBe('lieux');
    expect(atlas.subthemes.map((s) => s.slug)).toContain('insolite');
    expect(atlas.facets.lieu).toBe('saint-petersbourg');
    const ru = classify({ url: 'https://example.ru/zabroshennye', title: 'Заброшенные места Петербурга' });
    expect(ru.subthemes.map((s) => s.slug)).toContain('insolite');
    expect(ru.facets.lieu).toBe('saint-petersbourg');
  });

  it('sociologie de Saint-Pétersbourg sur cyberleninka', () => {
    const res = classify({ url: 'https://cyberleninka.ru/article/n/sotsiologiya-goroda', title: 'Социология города: Санкт-Петербург' });
    expect(res.primary).toBe('sociologie');
    expect(res.facets['content-type']).toBe('publication');
    expect(res.facets.lieu).toBe('saint-petersbourg');
  });
});

describe('compileKeyword', () => {
  it('frontière de début de mot seulement', () => {
    expect(compileKeyword('ui').test('build')).toBe(false);
    expect(compileKeyword('ui').test('ui kit')).toBe(true);
    expect(compileKeyword('photo').test('photography')).toBe(true);
    expect(compileKeyword('app.').test('whatsapp.com')).toBe(false);
    expect(compileKeyword('app.').test('https://app.example.com')).toBe(true);
    expect(compileKeyword('app.').test('appxexample')).toBe(false);
  });
});
