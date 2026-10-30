import { describe, expect, it } from 'vitest';
import { isRested, maxPage, nextState, priority, selectQueries } from '../src/explore/frontier.js';

describe('frontière — priorité', () => {
  it('une requête jamais lancée passe avant toutes les autres', () => {
    expect(priority({ runs: 0, newDomains: 0 })).toBe(Infinity);
    expect(priority({ runs: 1, newDomains: 1000 })).toBeLessThan(Infinity);
  });

  it('moyenne amortie : un passage chanceux ne bat pas une requête régulière', () => {
    expect(priority({ runs: 1, newDomains: 6 })).toBe(3);
    expect(priority({ runs: 4, newDomains: 20 })).toBe(4);
  });
});

describe('frontière — sélection', () => {
  const q = (id, runs, newDomains, lastRunAt = null) => ({ id, runs, newDomains, lastRunAt });

  it('jamais lancées, puis meilleur rendement, borné par le budget', () => {
    const picked = selectQueries([q(1, 2, 2), q(2, 0, 0), q(3, 2, 9), q(4, 0, 0)], 3);
    expect(picked.map((p) => p.id)).toEqual([2, 4, 3]);
  });

  it('à priorité égale : la moins récemment lancée, puis l’id', () => {
    const picked = selectQueries(
      [q(1, 1, 2, '2026-10-02'), q(2, 1, 2, '2026-10-01'), q(3, 1, 2, '2026-10-01')],
      5,
    );
    expect(picked.map((p) => p.id)).toEqual([2, 3, 1]);
  });

  it('budget 0 : aucune requête', () => {
    expect(selectQueries([q(1, 0, 0)], 0)).toEqual([]);
  });
});

describe('frontière — état après un passage', () => {
  it('la page avance ; une URL nouvelle remet le compteur à sec à 0', () => {
    expect(nextState({ provider: 'brave', page: 0, newUrls: 3, dryRuns: 1, dryRunsLimit: 2 })).toEqual({
      nextPage: 1, dryRuns: 0, exhausted: false,
    });
  });

  it('épuisée après N passages sans URL nouvelle', () => {
    expect(nextState({ provider: 'brave', page: 2, newUrls: 0, dryRuns: 0, dryRunsLimit: 2 }).exhausted).toBe(false);
    expect(nextState({ provider: 'brave', page: 3, newUrls: 0, dryRuns: 1, dryRunsLimit: 2 })).toEqual({
      nextPage: 4, dryRuns: 2, exhausted: true,
    });
  });

  it('épuisée après la dernière page du provider', () => {
    expect(maxPage('brave')).toBe(9);
    expect(nextState({ provider: 'brave', page: 8, newUrls: 5, dryRunsLimit: 2 }).exhausted).toBe(false);
    expect(nextState({ provider: 'brave', page: 9, newUrls: 5, dryRunsLimit: 2 }).exhausted).toBe(true);
  });
});

describe('frontière — repos', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  it('revient après restDays jours, pas avant', () => {
    expect(isRested('2026-10-01T12:00:00Z', now, 29)).toBe(true);
    expect(isRested('2026-10-01T12:00:00Z', now, 30)).toBe(false);
    expect(isRested(null, now, 30)).toBe(true);
  });
});
