import { describe, expect, it } from 'vitest';
import { defaultDatabaseUrl, intEnv } from '../src/env.js';

describe('intEnv', () => {
  it('rend le défaut si la variable est absente ou vide', () => {
    expect(intEnv('X', 7, 0, {})).toBe(7);
    expect(intEnv('X', 7, 0, { X: '' })).toBe(7);
  });

  it('lit un entier valide', () => {
    expect(intEnv('X', 7, 0, { X: '0' })).toBe(0);
    expect(intEnv('X', 7, 1, { X: '12' })).toBe(12);
  });

  it('refuse une valeur non entière en nommant la variable', () => {
    expect(() => intEnv('WEBPOOL_CONCURRENCY', 4, 1, { WEBPOOL_CONCURRENCY: 'abc' })).toThrow(/WEBPOOL_CONCURRENCY/);
    expect(() => intEnv('X', 4, 0, { X: '1.5' })).toThrow(/X/);
  });

  it('refuse une valeur sous le minimum', () => {
    expect(() => intEnv('WEBPOOL_CONCURRENCY', 4, 1, { WEBPOOL_CONCURRENCY: '0' })).toThrow(/≥ 1/);
    expect(() => intEnv('X', 4, 0, { X: '-1' })).toThrow(/≥ 0/);
  });
});

describe('defaultDatabaseUrl', () => {
  it('utilise le port 5432 par défaut', () => {
    expect(defaultDatabaseUrl({})).toBe('postgres://webpool:webpool@localhost:5432/webpool');
  });

  it('suit WEBPOOL_DB_PORT', () => {
    expect(defaultDatabaseUrl({ WEBPOOL_DB_PORT: '5433' })).toBe('postgres://webpool:webpool@localhost:5433/webpool');
  });
});
