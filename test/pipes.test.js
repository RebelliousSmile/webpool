import { describe, expect, it } from 'vitest';
import { DEFAULT_PIPE, nextPipe, pipeOf, pipeOrder, pressure, shouldSwitch, visitPressures } from '../src/explore/pipes.js';

const run = (goodDomains, judged = true) => ({ goodDomains, judged });

describe('tuyaux d’exploration', () => {
  it('pipeOf : première étiquette flot:, sinon defaut', () => {
    expect(pipeOf(['lang:ja', 'flot:japon', 'flot:autre'])).toBe('japon');
    expect(pipeOf(['lang:ja'])).toBe(DEFAULT_PIPE);
    expect(pipeOf(['flot:'])).toBe(DEFAULT_PIPE);
    expect(pipeOf()).toBe(DEFAULT_PIPE);
  });

  it('pipeOrder : ordre de première apparition par id de requête', () => {
    const queries = [
      { id: 3, tags: [] },
      { id: 1, tags: ['flot:b'] },
      { id: 2, tags: ['flot:a'] },
      { id: 4, tags: ['flot:b'] },
    ];
    expect(pipeOrder(queries)).toEqual(['b', 'a', DEFAULT_PIPE]);
    expect(pipeOrder([])).toEqual([]);
  });

  it('pressure : domaines bien notés par appel, null sans appel', () => {
    expect(pressure([run(4), run(1), run(1)])).toBe(2);
    expect(pressure([])).toBeNull();
  });

  it('visitPressures : seuls les appels jugés comptent, null sous la fenêtre', () => {
    expect(visitPressures([run(4), run(4), run(9, false)], 3)).toEqual({ reference: null, pressure: null, judged: 2 });
    const runs = [run(4), run(4), run(4), run(1), run(9, false), run(1), run(1)];
    expect(visitPressures(runs, 3)).toEqual({ reference: 4, pressure: 1, judged: 6 });
    // Fenêtres confondues tant qu'il n'y a que `window` appels jugés.
    expect(visitPressures([run(3), run(0), run(0)], 3)).toEqual({ reference: 1, pressure: 1, judged: 3 });
  });

  it('shouldSwitch : au seuil et sous le seuil, jamais sur une mesure inconnue', () => {
    const base = { dropRatio: 0.5, activeQueries: 2 };
    expect(shouldSwitch({ ...base, reference: 4, pressure: 2 })).toBe(true);
    expect(shouldSwitch({ ...base, reference: 4, pressure: 1 })).toBe(true);
    expect(shouldSwitch({ ...base, reference: 4, pressure: 2.1 })).toBe(false);
    expect(shouldSwitch({ ...base, reference: null, pressure: null })).toBe(false);
  });

  it('shouldSwitch : un tuyau stérile ou sans requête active est quitté', () => {
    expect(shouldSwitch({ reference: 0, pressure: 0, dropRatio: 0.5, activeQueries: 1 })).toBe(true);
    expect(shouldSwitch({ reference: null, pressure: null, dropRatio: 0.5, activeQueries: 0 })).toBe(true);
  });

  it('nextPipe : rotation, retour au premier, tuyaux sautés, lui-même en dernier recours', () => {
    const order = ['a', 'b', DEFAULT_PIPE];
    expect(nextPipe(order, 'a')).toBe('b');
    expect(nextPipe(order, DEFAULT_PIPE)).toBe('a');
    expect(nextPipe(order, 'a', new Set(['b']))).toBe(DEFAULT_PIPE);
    expect(nextPipe(['a'], 'a')).toBe('a');
    expect(nextPipe(order, 'a', new Set(order))).toBeNull();
  });
});
