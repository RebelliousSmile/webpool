import { describe, expect, it } from 'vitest';
import { assertPublicHost, isBlockedAddress, normalizeHost } from '../src/normalize/hostGuard.js';

const resolvesTo = (...addresses) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('normalizeHost', () => {
  it('retire les crochets et convertit une IPv4 mappée', () => {
    expect(normalizeHost('[::1]')).toBe('::1');
    expect(normalizeHost('[::ffff:7f00:1]')).toBe('127.0.0.1');
    expect(normalizeHost('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeHost('Example.COM')).toBe('example.com');
  });
});

describe('isBlockedAddress', () => {
  it.each([
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.168.0.1', '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:10.0.0.1',
  ])('bloque %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:2800:220:1::1'])('autorise %s', (ip) =>
    expect(isBlockedAddress(ip)).toBe(false),
  );
});

describe('assertPublicHost', () => {
  it('accepte une IP littérale publique sans résolution', async () => {
    const lookup = async () => {
      throw new Error('ne doit pas résoudre');
    };
    await expect(assertPublicHost('93.184.216.34', { lookup })).resolves.toBeUndefined();
  });

  it('refuse si une seule des adresses résolues est privée', async () => {
    await expect(assertPublicHost('a.example', { lookup: resolvesTo('93.184.216.34', '10.0.0.1') })).rejects.toThrow(
      /hôte refusé : a\.example \(10\.0\.0\.1\)/,
    );
  });

  it('refuse une IPv6 locale entre crochets', async () => {
    await expect(assertPublicHost('[::1]', { lookup: resolvesTo() })).rejects.toThrow(/hôte refusé/);
  });

  it('refuse une résolution vide', async () => {
    await expect(assertPublicHost('a.example', { lookup: resolvesTo() })).rejects.toThrow(/hôte refusé/);
  });

  it('ne contrôle rien si allowPrivate', async () => {
    await expect(assertPublicHost('127.0.0.1', { allowPrivate: true })).resolves.toBeUndefined();
  });

  it("marque l'erreur non rejouable", async () => {
    await expect(assertPublicHost('127.0.0.1')).rejects.toMatchObject({ retryable: false });
  });
});
