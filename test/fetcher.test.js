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
    maxRedirects: 5,
    allowPrivateHosts: false,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
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

const redirect = (location, status = 301) => new Response(null, { status, headers: { location } });

describe('fetcher — redirections manuelles', () => {
  it('suit deux sauts, renvoie la dernière URL, un créneau de throttle par saut', async () => {
    const { fetcher, calls, sleeps } = harness([
      redirect('/b'),
      redirect('https://a.com/c', 302),
      html('<title>fin</title>'),
    ]);
    const res = await fetcher('https://a.com/a');
    expect(res).toMatchObject({ finalUrl: 'https://a.com/c', httpStatus: 200 });
    expect(calls.map((c) => c.url)).toEqual(['https://a.com/a', 'https://a.com/b', 'https://a.com/c']);
    // même hôte : chaque saut attend perHostDelayMs après le précédent
    expect(sleeps).toEqual([1000, 1000]);
    expect(calls[2].at - calls[1].at).toBe(1000);
  });

  it('demande redirect manual à fetchImpl', async () => {
    let init;
    const { fetcher } = harness([], { fetchImpl: async (_url, i) => ((init = i), html('ok')) });
    await fetcher('https://a.com/');
    expect(init.redirect).toBe('manual');
  });

  it('traite un 3xx sans location comme la réponse finale', async () => {
    const { fetcher, calls } = harness([new Response(null, { status: 302 })]);
    expect((await fetcher('https://a.com/')).httpStatus).toBe(302);
    expect(calls).toHaveLength(1);
  });

  it('refuse une redirection vers un hôte privé, au saut', async () => {
    const { fetcher, calls } = harness([redirect('http://10.0.0.5/')]);
    await expect(fetcher('https://a.com/')).rejects.toThrow(/hôte refusé/);
    expect(calls).toHaveLength(1);
  });

  it('refuse au-delà de maxRedirects, sans retry', async () => {
    const loop = Array.from({ length: 10 }, (_, i) => redirect(`/r${i}`));
    const { fetcher, calls } = harness(loop, { maxRedirects: 2 });
    await expect(fetcher('https://a.com/')).rejects.toThrow(/trop de redirections/);
    expect(calls).toHaveLength(3);
  });

  it('rejoue la chaîne entière sur erreur transitoire', async () => {
    const { fetcher, calls } = harness([redirect('/b'), html('', 503), redirect('/b'), html('ok')]);
    const res = await fetcher('https://a.com/a');
    expect(res.httpStatus).toBe(200);
    expect(calls.map((c) => c.url)).toEqual(['https://a.com/a', 'https://a.com/b', 'https://a.com/a', 'https://a.com/b']);
  });
});

describe('fetcher — garde d’hôte', () => {
  it.each(['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/'])(
    'refuse %s sans appeler fetchImpl',
    async (url) => {
      const { fetcher, calls } = harness([html('ok')]);
      await expect(fetcher(url)).rejects.toThrow(/hôte refusé/);
      expect(calls).toHaveLength(0);
    },
  );

  it('refuse un nom qui résout vers une adresse privée', async () => {
    const { fetcher, calls } = harness([html('ok')], { lookup: async () => [{ address: '192.168.1.10', family: 4 }] });
    await expect(fetcher('https://intranet.example/')).rejects.toThrow(/hôte refusé/);
    expect(calls).toHaveLength(0);
  });

  it('laisse passer un hôte privé si allowPrivateHosts', async () => {
    const { fetcher, calls } = harness([html('ok')], { allowPrivateHosts: true });
    expect((await fetcher('http://127.0.0.1/')).httpStatus).toBe(200);
    expect(calls).toHaveLength(1);
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
