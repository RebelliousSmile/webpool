import { describe, expect, it } from 'vitest';
import {
  callCostUsd,
  checkRequest,
  eurosOf,
  giriFromCents,
  parseCallCosts,
  parseEuros,
  priceList,
  priceOf,
} from '../src/billing/pricing.js';

const rates = { usdEur: 0.92, markup: 2, giriPerEur: 1000 };

describe('prix des recherches', () => {
  it("prix d'un appel : coût majoré, arrondi au giri supérieur, 1 giri au moins", () => {
    expect(priceOf(0.0055, rates)).toBe(11); // 10,12 giri
    expect(priceOf(0.005, rates)).toBe(10); // 9,2 giri, sans erreur d'arrondi flottant
    expect(priceOf(0.0175, rates)).toBe(33);
    expect(priceOf(0, rates)).toBe(1);
    // exactement entier : pas de giri de trop
    expect(priceOf(0.005, { usdEur: 1, markup: 2, giriPerEur: 1000 })).toBe(10);
  });

  it('coût par provider : moteur OpenRouter, surcharges, défaut nul', () => {
    expect(callCostUsd('openrouter', { engine: 'perplexity' })).toBe(0.0055);
    expect(callCostUsd('openrouter', { engine: 'exa' })).toBe(0.0175);
    expect(callCostUsd('brave')).toBe(0.005);
    expect(callCostUsd('inconnu')).toBe(0);
    expect(callCostUsd('openrouter', { engine: 'exa', overrides: { openrouter: 0.01 } })).toBe(0.01);
    expect(callCostUsd('openrouter', { engine: 'exa', overrides: { 'openrouter:exa': 0.02, openrouter: 0.01 } })).toBe(0.02);
  });

  it('WEBPOOL_CALL_COST_USD : provider=coût, séparés par des virgules', () => {
    expect(parseCallCosts('')).toEqual({});
    expect(parseCallCosts('brave=0.004, openrouter:exa=0.02')).toEqual({ brave: 0.004, 'openrouter:exa': 0.02 });
    expect(() => parseCallCosts('brave:0.004')).toThrow(/WEBPOOL_CALL_COST_USD invalide/);
  });

  it("grille : providers ouverts et disponibles, jamais `file`, une page pour OpenRouter", () => {
    const list = priceList({
      providers: ['openrouter', 'brave', 'file', 'absent'],
      available: ['openrouter', 'brave', 'file'],
      engine: 'perplexity',
      overrides: {},
      maxPages: 3,
      ...rates,
    });
    expect(list).toEqual([
      { provider: 'openrouter', unit_price: 11, cost_usd: 0.0055, max_pages: 1 },
      { provider: 'brave', unit_price: 10, cost_usd: 0.005, max_pages: 3 },
    ]);
  });

  it('euros saisis en décimal → centimes, puis giri entiers', () => {
    expect(parseEuros('10')).toBe(1000);
    expect(parseEuros('12,5')).toBe(1250);
    expect(parseEuros(' 12.05 ')).toBe(1205);
    for (const bad of ['', '0', '1,234', '-5', '1e3', 'abc']) expect(() => parseEuros(bad)).toThrow();
    expect(giriFromCents(1250, 1000)).toBe(12500);
    expect(giriFromCents(1, 30)).toBe(0);
    expect(eurosOf(11, 1000)).toBe(0.011);
  });

  it('demande : requête nettoyée, provider ouvert, pages bornées', () => {
    const prices = [
      { provider: 'brave', unit_price: 10, max_pages: 3 },
      { provider: 'openrouter', unit_price: 11, max_pages: 1 },
    ];
    expect(checkRequest({ provider: 'brave', query: '  forêt   lora ', pages: 2 }, prices)).toEqual({
      provider: 'brave', query: 'forêt lora', pages: 2, unitPrice: 10,
    });
    expect(checkRequest({ provider: 'openrouter', query: 'q' }, prices).pages).toBe(1);
    expect(() => checkRequest({ provider: 'brave', query: ' ' }, prices)).toThrow(/query requis/);
    expect(() => checkRequest({ provider: 'brave', query: 'x'.repeat(201) }, prices)).toThrow(/200 caractères/);
    expect(() => checkRequest({ provider: 'file', query: '/etc/passwd' }, prices)).toThrow(/non ouvert/);
    expect(() => checkRequest({ provider: 'openrouter', query: 'q', pages: 2 }, prices)).toThrow(/entre 1 et 1/);
    expect(() => checkRequest({ provider: 'brave', query: 'q', pages: 1.5 }, prices)).toThrow(/pages/);
  });
});

describe('listes de liens', () => {
  const pricing = { perLink: 2, maxLinks: 3 };
  it('libellé, liens http(s) dédoublonnés, titres facultatifs, prix d’un bloc', async () => {
    const { checkLinkList } = await import('../src/billing/pricing.js');
    expect(checkLinkList({ query: '  Japon   sélection ', links: ['https://a.jp/x', { url: 'https://b.jp', title: ' B ' }, 'https://a.jp/x'] }, pricing))
      .toEqual({
        provider: 'list',
        query: 'Japon sélection',
        pages: 1,
        unitPrice: 4,
        links: [{ url: 'https://a.jp/x', title: null }, { url: 'https://b.jp', title: 'B' }],
      });
  });

  it('refuse libellé vide, liste vide, URL invalide ou non http, titre trop long, trop de liens', async () => {
    const { checkLinkList } = await import('../src/billing/pricing.js');
    const check = (args) => () => checkLinkList(args, pricing);
    expect(check({ query: ' ', links: ['https://a.jp'] })).toThrow(/libellé de la liste/);
    expect(check({ query: 'x'.repeat(201), links: ['https://a.jp'] })).toThrow(/200 caractères/);
    expect(check({ query: 'q', links: [] })).toThrow(/links requis/);
    expect(check({ query: 'q', links: 'https://a.jp' })).toThrow(/links requis/);
    expect(check({ query: 'q', links: [{}] })).toThrow(/lien 1 : URL manquante/);
    expect(check({ query: 'q', links: ['pas une url'] })).toThrow(/lien 1 : URL invalide/);
    expect(check({ query: 'q', links: ['file:///etc/passwd'] })).toThrow(/http ou https seulement/);
    expect(check({ query: 'q', links: [`https://a.jp/${'x'.repeat(2000)}`] })).toThrow(/2000 caractères/);
    expect(check({ query: 'q', links: [{ url: 'https://a.jp', title: 'x'.repeat(301) }] })).toThrow(/titre de 300/);
    expect(check({ query: 'q', links: ['https://a.jp/1', 'https://a.jp/2', 'https://a.jp/3', 'https://a.jp/4'] })).toThrow(/3 liens au plus/);
  });
});
