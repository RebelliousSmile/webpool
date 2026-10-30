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

  it('unsplash.com : photographie, licence libre', () => {
    const res = classify({ url: 'https://unsplash.com/photos/forest' });
    expect(res.primary).toBe('photographie');
    expect(res.facets.licence).toBe('libre');
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
