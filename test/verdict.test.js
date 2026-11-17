import { describe, expect, it } from 'vitest';
import { errorLabel, nextState, verdictOf } from '../src/check/verdict.js';
import { HostRefusedError } from '../src/normalize/hostGuard.js';
import { TooManyRedirectsError } from '../src/normalize/fetcher.js';

// Erreur réseau telle qu'undici la lève : « fetch failed » enveloppant l'erreur système.
const coded = (code) => Object.assign(new Error(code), { code });
const wrapped = (code) => new TypeError('fetch failed', { cause: coded(code) });

describe('verdictOf : statut HTTP', () => {
  it.each([200, 204, 299])('%i → ok', (httpStatus) => {
    expect(verdictOf({ httpStatus })).toEqual({ verdict: 'ok', label: null });
  });

  it.each([404, 410])('%i → dead', (httpStatus) => {
    expect(verdictOf({ httpStatus })).toEqual({ verdict: 'dead', label: null });
  });

  it.each([301, 400, 401, 403, 429, 500, 503])('%i → unsure', (httpStatus) => {
    expect(verdictOf({ httpStatus })).toEqual({ verdict: 'unsure', label: null });
  });
});

describe('verdictOf : erreurs', () => {
  it.each([
    ['ENOTFOUND non enveloppé (assertPublicHost)', coded('ENOTFOUND'), 'ENOTFOUND'],
    ['ENOTFOUND sous fetch failed', wrapped('ENOTFOUND'), 'ENOTFOUND'],
    ['ECONNREFUSED', wrapped('ECONNREFUSED'), 'ECONNREFUSED'],
    ['certificat expiré', wrapped('CERT_HAS_EXPIRED'), 'CERT_HAS_EXPIRED'],
    ['certificat pour un autre nom', wrapped('ERR_TLS_CERT_ALTNAME_INVALID'), 'ERR_TLS_CERT_ALTNAME_INVALID'],
    ['hôte devenu privé', new HostRefusedError('x.example', '10.0.0.1'), 'HOST_REFUSED'],
  ])('%s → dead', (_, error, label) => {
    expect(verdictOf({ error })).toEqual({ verdict: 'dead', label });
  });

  it.each([
    ['délai dépassé', new DOMException('timeout', 'TimeoutError'), 'TimeoutError'],
    ['EAI_AGAIN', wrapped('EAI_AGAIN'), 'EAI_AGAIN'],
    ['connexion coupée', wrapped('ECONNRESET'), 'ECONNRESET'],
    ['trop de redirections', new TooManyRedirectsError('https://x.example/', 5), 'TOO_MANY_REDIRECTS'],
    ['chaîne de certificats incomplète', wrapped('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
    ['erreur inconnue', new Error('boum'), 'UNKNOWN'],
  ])('%s → unsure', (_, error, label) => {
    expect(verdictOf({ error })).toEqual({ verdict: 'unsure', label });
  });

  it('une erreur prime sur un statut', () => {
    expect(verdictOf({ httpStatus: 200, error: wrapped('ENOTFOUND') }).verdict).toBe('dead');
  });
});

describe('errorLabel', () => {
  it('résiste à une chaîne cause circulaire', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(errorLabel(a)).toBe('UNKNOWN');
  });

  it("préfère le premier code de la chaîne, puis un nom autre qu'Error", () => {
    expect(errorLabel(new TypeError('fetch failed', { cause: coded('ECONNRESET') }))).toBe('ECONNRESET');
    expect(errorLabel(new TypeError('x', { cause: new RangeError('y') }))).toBe('RangeError');
  });
});

describe('nextState', () => {
  const t = (d) => new Date(`2026-11-0${d}T04:00:00Z`);

  it('trois dead consécutifs mettent en quarantaine à la date du troisième', () => {
    let s = { streak: 0, quarantinedAt: null };
    for (const d of [3, 4]) {
      s = nextState({ ...s, verdict: 'dead', now: t(d) });
      expect(s.quarantinedAt).toBeNull();
    }
    s = nextState({ ...s, verdict: 'dead', now: t(5) });
    expect(s).toEqual({ streak: 3, quarantinedAt: t(5) });
  });

  it('un unsure entre deux dead ne compte pas et ne remet pas à zéro', () => {
    let s = nextState({ streak: 0, quarantinedAt: null, verdict: 'dead', now: t(3) });
    s = nextState({ ...s, verdict: 'unsure', now: t(4) });
    expect(s).toEqual({ streak: 1, quarantinedAt: null });
    s = nextState({ ...s, verdict: 'dead', now: t(5) });
    s = nextState({ ...s, verdict: 'dead', now: t(6) });
    expect(s).toEqual({ streak: 3, quarantinedAt: t(6) });
  });

  it('un ok remet le compteur à zéro et lève la quarantaine', () => {
    expect(nextState({ streak: 4, quarantinedAt: t(3), verdict: 'ok', now: t(6) })).toEqual({ streak: 0, quarantinedAt: null });
  });

  it('un dead en quarantaine garde la date d’origine', () => {
    expect(nextState({ streak: 3, quarantinedAt: t(3), verdict: 'dead', now: t(4) })).toEqual({ streak: 4, quarantinedAt: t(3) });
  });

  it('le seuil est paramétrable', () => {
    expect(nextState({ streak: 0, quarantinedAt: null, verdict: 'dead', now: t(3), threshold: 1 }).quarantinedAt).toEqual(t(3));
  });
});
