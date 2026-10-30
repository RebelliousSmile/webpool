// Garde SSRF : la normalisation visite des URL venues de l'extérieur (SERP) ;
// aucune requête ne doit partir vers la machine locale, le réseau privé ou un
// service de métadonnées cloud. Risque résiduel accepté : le DNS rebinding entre
// la résolution ci-dessous et la connexion de fetch.
import dns from 'node:dns';
import net from 'node:net';

const blocked = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
]) {
  blocked.addSubnet(prefix, bits, 'ipv4');
}
blocked.addAddress('::', 'ipv6');
blocked.addAddress('::1', 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');

export class HostRefusedError extends Error {
  constructor(hostname, address) {
    super(`hôte refusé : ${hostname}${address && address !== hostname ? ` (${address})` : ''} n'est pas une adresse publique`);
    this.retryable = false;
  }
}

// IPv4 mappée (`::ffff:7f00:1` ou `::ffff:127.0.0.1`) → IPv4, sinon null.
function mappedIpv4(ip) {
  const m = /^::ffff:(.+)$/i.exec(ip);
  if (!m) return null;
  if (net.isIPv4(m[1])) return m[1];
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(m[1]);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

// `new URL().hostname` garde les crochets d'une IPv6 : `[::1]`.
export function normalizeHost(hostname) {
  const host = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return mappedIpv4(host) ?? host;
}

export function isBlockedAddress(address) {
  const ip = normalizeHost(address);
  const family = net.isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) return blocked.check(ip, 'ipv6');
  return true; // pas une IP : refus par prudence
}

// Résout l'hôte et refuse si une seule de ses adresses n'est pas publique.
export async function assertPublicHost(hostname, { lookup = dns.promises.lookup, allowPrivate = false } = {}) {
  if (allowPrivate) return;
  const host = normalizeHost(hostname);
  const addresses = net.isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  const bad = addresses.find(isBlockedAddress);
  if (bad || addresses.length === 0) throw new HostRefusedError(hostname, bad);
}
