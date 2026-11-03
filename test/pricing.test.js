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
