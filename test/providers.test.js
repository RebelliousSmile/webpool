import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { providers } from '../src/ingest/index.js';
import * as brave from '../src/ingest/providers/brave.js';
import * as searxng from '../src/ingest/providers/searxng.js';
import * as europeana from '../src/ingest/providers/europeana.js';
import * as flickr from '../src/ingest/providers/flickr.js';
import * as openrouter from '../src/ingest/providers/openrouter.js';
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

// US-11 — mapping des réponses et construction des requêtes de chaque provider.
const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('providers SERP — contrat {url, rank, title}', () => {
  it('sont tous enregistrés derrière la même abstraction', () => {
    expect(Object.keys(providers).sort()).toEqual(['brave', 'europeana', 'file', 'flickr', 'openrouter', 'searxng']);
    for (const impl of Object.values(providers)) expect(typeof impl.search).toBe('function');
  });

  it('brave : mappe web.results', () => {
    expect(brave.mapResponse(fixture('brave-response.json'))).toEqual([
      { url: 'https://civitai.com/models/1', rank: 1, title: 'Forest LoRA — Civitai', thumbnail: 'https://imgs.search.brave.com/abc.jpg' },
      { url: 'https://example.com/no-title', rank: 2, title: null, thumbnail: null },
    ]);
    expect(brave.buildUrl('a b', 50).searchParams.get('count')).toBe('20');
  });

  it('searxng : ignore les entrées sans url, respecte limit, force format=json', () => {
    const data = fixture('searxng-response.json');
    expect(searxng.mapResponse(data).map((r) => r.url)).toEqual([
      'https://civitai.com/models/1',
      'https://example.com/a',
      'https://example.com/b',
    ]);
    expect(searxng.mapResponse(data, 2)).toHaveLength(2);
    const url = searxng.buildUrl('http://localhost:8080', 'forest lora');
    expect(url.toString()).toBe('http://localhost:8080/search?q=forest+lora&format=json');
    expect(searxng.buildUrl('https://s.example/sub/', 'x').pathname).toBe('/sub/search');
  });

  it('europeana : URL item depuis id, titre tableau ou chaîne, ignore sans id', () => {
    expect(europeana.mapResponse(fixture('europeana-response.json'))).toEqual([
      {
        url: 'https://www.europeana.eu/item/2048128/Athena_Plus_ProvidedCHO_1',
        rank: 1,
        title: 'La forêt de Fontainebleau',
        thumbnail: 'https://api.europeana.eu/thumbnail/v2/url.json?uri=x&type=IMAGE',
      },
      { url: 'https://www.europeana.eu/item/9200/BibliographicResource_2', rank: 2, title: 'Titre simple', thumbnail: null },
    ]);
    const url = europeana.buildUrl('forêt', 'KEY', 500);
    expect(url.searchParams.get('wskey')).toBe('KEY');
    expect(url.searchParams.get('rows')).toBe('100');
  });

  it('flickr : URL de page photo, titre vide → null, erreur API → exception', () => {
    expect(flickr.mapResponse(fixture('flickr-response.json'))).toEqual([
      {
        url: 'https://www.flickr.com/photos/12345678@N00/53000001',
        rank: 1,
        title: 'Sous-bois en automne',
        thumbnail: 'https://live.staticflickr.com/65535/53000001_abc_w.jpg',
      },
      { url: 'https://www.flickr.com/photos/87654321@N00/53000002', rank: 2, title: null, thumbnail: null },
    ]);
    expect(() => flickr.mapResponse(fixture('flickr-error.json'))).toThrow(/Invalid API Key.*100/);
    expect(flickr.buildUrl('x', 'K').searchParams.get('nojsoncallback')).toBe('1');
    expect(flickr.buildUrl('x', 'K').searchParams.get('extras')).toBe('url_w');
  });

  it('search : appelle fetch avec la clé et mappe le résultat', async () => {
    let seen;
    const res = await brave.search(
      { query: 'q' },
      { apiKey: 'BK', fetchImpl: async (url, init) => ((seen = init), jsonResponse(fixture('brave-response.json'))) },
    );
    expect(seen.headers['X-Subscription-Token']).toBe('BK');
    expect(res).toHaveLength(2);
  });

  it('page : sans page, aucun paramètre de pagination ; sinon chaque provider traduit la page 0-based', () => {
    const params = (url) => Object.fromEntries(url.searchParams);
    expect(params(brave.buildUrl('q', 20))).not.toHaveProperty('offset');
    expect(params(brave.buildUrl('q', 20, 0))).not.toHaveProperty('offset');
    expect(params(brave.buildUrl('q', 20, 3)).offset).toBe('3');
    expect(params(searxng.buildUrl('http://s', 'q'))).not.toHaveProperty('pageno');
    expect(params(searxng.buildUrl('http://s', 'q', 2)).pageno).toBe('3');
    expect(params(flickr.buildUrl('q', 'K', 20))).not.toHaveProperty('page');
    expect(params(flickr.buildUrl('q', 'K', 20, 1)).page).toBe('2');
    expect(params(europeana.buildUrl('q', 'K', 20))).not.toHaveProperty('start');
    expect(params(europeana.buildUrl('q', 'K', 20, 2)).start).toBe('41');
  });

  it('search : transmet la page au provider', async () => {
    let seen;
    await brave.search(
      { query: 'q', page: 4 },
      { apiKey: 'BK', fetchImpl: async (url) => ((seen = new URL(url)), jsonResponse(fixture('brave-response.json'))) },
    );
    expect(seen.searchParams.get('offset')).toBe('4');
  });

  it('search : clé ou URL absente → message explicite, erreur HTTP → message lisible', async () => {
    await expect(europeana.search({ query: 'q' }, { apiKey: '' })).rejects.toThrow(/EUROPEANA_API_KEY manquante/);
    await expect(searxng.search({ query: 'q' }, { baseUrl: '' })).rejects.toThrow(/SEARXNG_URL manquante/);
    await expect(
      flickr.search({ query: 'q' }, { apiKey: 'K', fetchImpl: async () => jsonResponse({}, 429) }),
    ).rejects.toThrow(/Flickr : HTTP 429 \(quota dépassé/);
    await expect(
      brave.search({ query: 'q' }, { apiKey: 'BK', fetchImpl: async () => jsonResponse({}, 401) }),
    ).rejects.toThrow(/Brave Search : HTTP 401 \(clé API refusée\)/);
  });
});

describe('provider openrouter — plugin web', () => {
  it('mappe les annotations url_citation : titre vide → null, doublon et autre type ignorés', () => {
    expect(openrouter.mapResponse(fixture('openrouter-response.json'))).toEqual([
      { url: 'https://urban3p.ru/spb/1', rank: 1, title: 'Заброшенный завод' },
      { url: 'https://example.com/no-title', rank: 2, title: null },
    ]);
    expect(openrouter.mapResponse({})).toEqual([]);
  });

  it('corps : moteur, max_results plafonné à 20, exclude_domains seulement si non vide', () => {
    const body = openrouter.buildBody('q', { limit: 50, engine: 'exa', model: 'm' });
    expect(body).toMatchObject({ model: 'm', max_tokens: 5, plugins: [{ id: 'web', engine: 'exa', max_results: 20 }] });
    expect(body.plugins[0]).not.toHaveProperty('exclude_domains');
    expect(body.messages[0].content).toContain('q');
    const excluding = openrouter.buildBody('q', { excludeDomains: ['reddit.com'] });
    expect(excluding.plugins[0]).toMatchObject({ engine: 'perplexity', exclude_domains: ['reddit.com'] });
    expect(() => openrouter.buildBody('q', { engine: 'google' })).toThrow(/Moteur OpenRouter inconnu : google/);
  });

  it('search : POST JSON avec la clé, page ignorée, exclusion transmise', async () => {
    let seen;
    const res = await openrouter.search(
      { query: 'q', limit: 20, page: 3, excludeDomains: ['a.com'] },
      {
        apiKey: 'OK',
        engine: 'parallel',
        model: 'm',
        fetchImpl: async (url, init) => ((seen = { url, init }), jsonResponse(fixture('openrouter-response.json'))),
      },
    );
    expect(seen.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(seen.init.method).toBe('POST');
    expect(seen.init.headers).toMatchObject({ Authorization: 'Bearer OK', 'Content-Type': 'application/json' });
    expect(JSON.parse(seen.init.body).plugins[0]).toEqual({
      id: 'web', engine: 'parallel', max_results: 20, exclude_domains: ['a.com'],
    });
    expect(res).toHaveLength(2);
  });

  it('search : clé absente → message explicite, crédit épuisé → HTTP 402 lisible', async () => {
    await expect(openrouter.search({ query: 'q' }, { apiKey: '' })).rejects.toThrow(/OPENROUTER_API_KEY manquante/);
    await expect(
      openrouter.search({ query: 'q' }, { apiKey: 'K', fetchImpl: async () => jsonResponse({}, 402) }),
    ).rejects.toThrow(/OpenRouter : HTTP 402 \(crédit épuisé\)/);
  });
});
