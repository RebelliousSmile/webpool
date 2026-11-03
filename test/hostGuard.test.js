import { describe, expect, it } from 'vitest';
import { assertPublicHost, embeddedIpv4, isBlockedAddress, normalizeHost } from '../src/normalize/hostGuard.js';

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

  it.each([
    ['multicast IPv4', '224.0.0.1'],
    ['multicast IPv4 (haut)', '239.255.255.250'],
    ['240/4 réservé', '240.0.0.1'],
    ['diffusion', '255.255.255.255'],
    ['banc d’essai 198.18/15', '198.19.255.1'],
    ['affectations IETF 192.0.0/24', '192.0.0.170'],
    ['documentation 192.0.2/24', '192.0.2.1'],
    ['documentation 198.51.100/24', '198.51.100.7'],
    ['documentation 203.0.113/24', '203.0.113.9'],
    ['relais 6to4 192.88.99/24', '192.88.99.1'],
    ['multicast IPv6', 'ff02::1'],
    ['multicast IPv6 global', 'ff0e::1'],
    ['site local fec0::/10', 'fec0::1'],
    ['discard 100::/64', '100::1'],
    ['documentation 2001:db8::/32', '2001:db8::1'],
    ['documentation 3fff::/20', '3fff::1'],
    ['Teredo 2001::/32', '2001:0:4136:e378::1'],
    ['banc d’essai 2001:2::/48', '2001:2::1'],
    ['NAT64 local 64:ff9b:1::/48', '64:ff9b:1::a00:1'],
    ['hors 2000::/3', '4000::1'],
    ['zone de lien', 'fe80::1%eth0'],
    ['pas une IP', 'example.com'],
  ])('bloque %s (%s)', (_label, ip) => expect(isBlockedAddress(ip)).toBe(true));

  // Chaque forme d'IPv4 encapsulée : jugée sur l'IPv4 qu'elle contient.
  it.each([
    ['mappée hexadécimale', '::ffff:7f00:1'],
    ['mappée pointée', '::ffff:169.254.169.254'],
    ['compatible ::/96', '::127.0.0.1'],
    ['compatible ::/96 hexadécimale', '::a00:1'],
    ['NAT64 64:ff9b::/96', '64:ff9b::127.0.0.1'],
    ['NAT64 hexadécimale', '64:ff9b::a9fe:a9fe'],
    ['6to4 2002::/16', '2002:7f00:1::1'],
    ['6to4 vers 10/8', '2002:a00:1::'],
    ['6to4 vers multicast', '2002:e000:1::1'],
  ])('bloque l’IPv4 encapsulée, %s (%s)', (_label, ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each([
    '93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '198.20.0.1', '223.255.255.254', '2606:2800:220:1::1',
    '2a00:1450:4007:80c::200e', '[2606:4700::1111]', '::ffff:8.8.8.8', '64:ff9b::8.8.8.8', '64:ff9b::808:808', '2002:808:808::1',
  ])('autorise %s', (ip) => expect(isBlockedAddress(ip)).toBe(false));
});

describe('embeddedIpv4', () => {
  it.each([
    ['::ffff:7f00:1', '127.0.0.1'],
    ['::ffff:1.2.3.4', '1.2.3.4'],
    ['::1', '0.0.0.1'],
    ['64:ff9b::c000:221', '192.0.2.33'],
    ['2002:c000:221:1::5', '192.0.2.33'],
    ['2606:2800:220:1::1', null],
    ['1.2.3.4', null],
  ])('%s → %s', (ip, v4) => expect(embeddedIpv4(ip)).toBe(v4));
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
