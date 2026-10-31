import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { config } from '../src/config.js';
import { defaultDatabaseUrl, intEnv, numberEnv, ratioEnv } from '../src/env.js';

describe('config', () => {
  it('est gelée : une modification lève une erreur', () => {
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      config.taxonomyPath = 'ailleurs.json';
    }).toThrow(TypeError);
  });

  it('annonce la version de package.json dans le User-Agent', () => {
    const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(config.userAgent).toContain(`webpool/${version}`);
  });
});

describe('numberEnv', () => {
  it('lit un décimal borné, exclusif ou non', () => {
    expect(numberEnv('X', 2, {}, {})).toBe(2);
    expect(numberEnv('X', 2, { min: 1 }, { X: '1.5' })).toBe(1.5);
    expect(numberEnv('X', 2, { min: 1 }, { X: '1' })).toBe(1);
    expect(() => numberEnv('WEBPOOL_USD_EUR', 1, { min: 0, exclusive: true }, { WEBPOOL_USD_EUR: '0' })).toThrow(/WEBPOOL_USD_EUR doit être un nombre > 0/);
    expect(() => numberEnv('X', 2, { min: 1 }, { X: '0.5' })).toThrow(/≥ 1/);
    expect(() => numberEnv('X', 2, {}, { X: 'abc' })).toThrow();
  });
});

describe('ratioEnv', () => {
  it('rend le défaut, lit une fraction, refuse hors de [0, 1] en nommant la variable', () => {
    expect(ratioEnv('X', 0.5, {})).toBe(0.5);
    expect(ratioEnv('X', 0.5, { X: '' })).toBe(0.5);
    expect(ratioEnv('X', 0.5, { X: '0.25' })).toBe(0.25);
    expect(ratioEnv('X', 0.5, { X: '1' })).toBe(1);
    expect(() => ratioEnv('WEBPOOL_PIPE_DROP_RATIO', 0.5, { WEBPOOL_PIPE_DROP_RATIO: '1.5' })).toThrow(/WEBPOOL_PIPE_DROP_RATIO/);
    expect(() => ratioEnv('X', 0.5, { X: 'abc' })).toThrow(/entre 0 et 1/);
  });

  it('donne aux tuyaux leurs valeurs par défaut', () => {
    expect([config.pipeGoodScore, config.pipeWindow, config.pipeDropRatio]).toEqual([0.5, 3, 0.5]);
  });
});

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
