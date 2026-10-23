import { describe, expect, it } from 'vitest';
import { createFetcher, isTransientStatus, mapLimit, readHead } from '../src/normalize/fetcher.js';

const html = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });

function harness(responses, opts = {}) {
  let t = 0;
  const sleeps = [];
  const calls = [];
  const queue = [...responses];
  const fetcher = createFetcher({
    perHostDelayMs: 1000,
    retries: 2,
    backoffMs: 100,
    maxBodyBytes: 1000,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    fetchImpl: async (url) => {
      calls.push({ url, at: t });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    ...opts,
  });
  return { fetcher, sleeps, calls };
}

describe('fetcher — politesse par hôte', () => {
  it('espace deux requêtes vers un même hôte, pas vers des hôtes différents', async () => {
    const { fetcher, calls, sleeps } = harness([html('a'), html('b'), html('c')]);
    await Promise.all([
      fetcher('https://a.com/1'),
      fetcher('https://a.com/2'),
      fetcher('https://b.com/1'),
    ]);
    // seul le 2e appel vers a.com attend : un délai, et il passe après le 1er
    expect(sleeps).toEqual([1000]);
    const order = calls.map((c) => c.url);
    expect(order.indexOf('https://a.com/1')).toBeLessThan(order.indexOf('https://a.com/2'));
  });
});

describe('fetcher — retry borné', () => {
  it('réessaie sur 503 avec backoff exponentiel puis réussit', async () => {
    const { fetcher, calls } = harness([html('', 503), html('', 500), html('<title>ok</title>')]);
    const res = await fetcher('https://a.com/');
    expect(res.httpStatus).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it('respecte Retry-After sur 429', async () => {
    const { fetcher, sleeps } = harness([html('', 429, { 'retry-after': '3' }), html('ok')]);
    await fetcher('https://a.com/');
    expect(sleeps).toContain(3000);
  });

  it("s'arrête après `retries` tentatives et renvoie la dernière réponse", async () => {
    const { fetcher, calls } = harness([html('', 503), html('', 503), html('', 503), html('', 200)]);
    const res = await fetcher('https://a.com/');
    expect(res.httpStatus).toBe(503);
    expect(calls).toHaveLength(3);
  });

  it('réessaie une erreur réseau puis propage la dernière', async () => {
    const { fetcher, calls } = harness([new Error('t1'), new Error('t2'), new Error('t3')]);
    await expect(fetcher('https://a.com/')).rejects.toThrow('t3');
    expect(calls).toHaveLength(3);
  });

  it('ne réessaie pas un 404', async () => {
    const { fetcher, calls } = harness([html('', 404), html('ok')]);
    const res = await fetcher('https://a.com/');
    expect(res.httpStatus).toBe(404);
    expect(calls).toHaveLength(1);
    expect(isTransientStatus(404)).toBe(false);
  });
});

describe('fetcher — corps limité', () => {
  it('ne lit pas au-delà de </head>', async () => {
    const big = `<html><head><title>T</title></head><body>${'x'.repeat(50_000)}</body></html>`;
    const res = await readHead(html(big), 100_000);
    expect(res).toContain('<title>T</title>');
    expect(res.length).toBeLessThan(5_000);
  });

  it('plafonne à maxBytes quand </head> est absent', async () => {
    const res = await readHead(html('y'.repeat(50_000)), 1000);
    expect(res).toHaveLength(1000);
  });

  it('ignore le corps non-HTML', async () => {
    const { fetcher } = harness([new Response('{"a":1}', { headers: { 'content-type': 'application/json' } })]);
    expect((await fetcher('https://a.com/x.json')).html).toBe('');
  });
});

describe('mapLimit', () => {
  it('borne la concurrence et conserve l’ordre, erreurs isolées', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      if (n === 3) throw new Error('boom');
      return n * 10;
    });
    expect(peak).toBe(2);
    expect(out.map((r) => r.value)).toEqual([10, 20, undefined, 40, 50, 60]);
    expect(out[2].error.message).toBe('boom');
  });
});
