// Garde SSRF : la normalisation et le cache de médias visitent des URL venues
// de l'extérieur (SERP, recherches payantes) ; aucune requête ne doit partir vers
// la machine locale, un réseau privé, une plage réservée ou un service de
// métadonnées cloud. Seul l'unicast global public est accepté.
//
// Deux contrôles : assertPublicHost avant la requête (refus rapide, IP
// littérales), et createConnectLookup au moment même de la connexion, qui
// fixe l'adresse jugée : un DNS rebinding entre les deux ne passe pas.
import dns from 'node:dns';
import net from 'node:net';

export class HostRefusedError extends Error {
  constructor(hostname, address) {
    super(`hôte refusé : ${hostname}${address && address !== hostname ? ` (${address})` : ''} n'est pas une adresse publique`);
    this.retryable = false;
  }
}

// --- Adresses en entiers ------------------------------------------------------

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

const intToIpv4 = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

// IPv6 (validée par net.isIPv6) → BigInt de 128 bits ; queue IPv4 pointée comprise.
function ipv6ToBigInt(ip) {
  let text = ip;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const n = ipv4ToInt(tail[1]);
    text = `${text.slice(0, tail.index)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, rest] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = rest === undefined ? [] : rest ? rest.split(':') : [];
  const groups = rest === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

const cidr4 = (prefix, bits) => ({ base: ipv4ToInt(prefix), bits });
const in4 = (n, { base, bits }) => bits === 0 || n >>> (32 - bits) === base >>> (32 - bits);

const cidr6 = (prefix, bits) => ({ base: ipv6ToBigInt(prefix), bits: BigInt(bits) });
const in6 = (n, { base, bits }) => n >> (128n - bits) === base >> (128n - bits);

// --- Plages ------------------------------------------------------------------

// Registre IANA des adresses IPv4 à usage spécial, multicast et réservé.
const BLOCKED_V4 = [
  ['0.0.0.0', 8], // « ce réseau »
  ['10.0.0.0', 8], // privé
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // boucle locale
  ['169.254.0.0', 16], // lien local, métadonnées cloud
  ['172.16.0.0', 12], // privé
  ['192.0.0.0', 24], // affectations IETF
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // relais 6to4 (obsolète)
  ['192.168.0.0', 16], // privé
  ['198.18.0.0', 15], // banc d'essai
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // réservé, diffusion 255.255.255.255 comprise
].map(([p, b]) => cidr4(p, b));

// IPv6 : seul 2000::/3 (unicast global) est routé sur Internet ; tout le reste
// (::1, fc00::/7, fe80::/10, fec0::/10, ff00::/8, 100::/64…) est refusé, sauf
// les formes qui encapsulent une IPv4, décodées puis jugées en IPv4.
const GLOBAL_V6 = cidr6('2000::', 3);
const BLOCKED_V6 = [
  ['2001::', 23], // affectations IETF : Teredo, banc d'essai, ORCHID…
  ['2001:db8::', 32], // documentation
  ['3fff::', 20], // documentation (RFC 9637)
].map(([p, b]) => cidr6(p, b));

// Préfixe → position (en bits depuis la droite) de l'IPv4 encapsulée.
const EMBEDDED_V4 = [
  [cidr6('::ffff:0:0', 96), 0n], // IPv4 mappée
  [cidr6('::', 96), 0n], // IPv4 compatible (obsolète) ; :: et ::1 y tombent
  [cidr6('64:ff9b::', 96), 0n], // NAT64 bien connu
  [cidr6('2002::', 16), 80n], // 6to4 : 2002:AABB:CCDD::/48
];

// IPv4 encapsulée dans une IPv6 (chaîne pointée), sinon null.
export function embeddedIpv4(ip) {
  if (!net.isIPv6(ip)) return null;
  const n = ipv6ToBigInt(ip);
  for (const [range, shift] of EMBEDDED_V4) {
    if (in6(n, range)) return intToIpv4(Number((n >> shift) & 0xffffffffn));
  }
  return null;
}

// `new URL().hostname` garde les crochets d'une IPv6 : `[::1]`. Une IPv4
// mappée (`::ffff:7f00:1`) est ramenée à sa forme IPv4.
export function normalizeHost(hostname) {
  const host = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (net.isIPv6(host) && in6(ipv6ToBigInt(host), EMBEDDED_V4[0][0])) return embeddedIpv4(host);
  return host;
}

function isBlockedV4(ip) {
  const n = ipv4ToInt(ip);
  return BLOCKED_V4.some((range) => in4(n, range));
}

export function isBlockedAddress(address) {
  const ip = normalizeHost(String(address));
  if (net.isIPv4(ip)) return isBlockedV4(ip);
  if (!net.isIPv6(ip) || ip.includes('%')) return true; // pas une IP, ou zone de lien : refus
  const v4 = embeddedIpv4(ip);
  if (v4) return isBlockedV4(v4);
  const n = ipv6ToBigInt(ip);
  return !in6(n, GLOBAL_V6) || BLOCKED_V6.some((range) => in6(n, range));
}

// --- Contrôles -----------------------------------------------------------------

// Résout l'hôte et refuse si une seule de ses adresses n'est pas publique.
export async function assertPublicHost(hostname, { lookup = dns.promises.lookup, allowPrivate = false } = {}) {
  if (allowPrivate) return;
  const host = normalizeHost(hostname);
  const addresses = net.isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  const bad = addresses.find(isBlockedAddress);
  if (bad || addresses.length === 0) throw new HostRefusedError(hostname, bad);
}

// `lookup` au format de net.connect (rappel), pour `new undici.Agent({ connect:
// { lookup } })` : résout par `lookup` (promesse, comme dns.promises.lookup),
// refuse si une seule adresse est bloquée, et rend à la socket exactement les
// adresses jugées. Une IP littérale ne passe pas par ici (net ne la résout
// pas) : assertPublicHost la contrôle avant la requête.
export function createConnectLookup({ lookup = dns.promises.lookup, isBlocked = isBlockedAddress } = {}) {
  return function connectLookup(hostname, options, callback) {
    const done = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options !== null ? options : {};
    Promise.resolve()
      .then(() => lookup(hostname, { all: true }))
      .then((records) => {
        const list = (Array.isArray(records) ? records : [records]).map((r) =>
          typeof r === 'string' ? { address: r, family: net.isIP(r) } : { address: r.address, family: r.family ?? net.isIP(r.address) },
        );
        const bad = list.find((r) => isBlocked(r.address));
        if (bad || list.length === 0) throw new HostRefusedError(hostname, bad?.address);
        const wanted = opts.family === 4 || opts.family === 6 ? list.filter((r) => r.family === opts.family) : list;
        if (wanted.length === 0) throw Object.assign(new Error(`aucune adresse IPv${opts.family} pour ${hostname}`), { code: 'ENOTFOUND' });
        return wanted;
      })
      .then(
        (list) => process.nextTick(() => (opts.all ? done(null, list) : done(null, list[0].address, list[0].family))),
        (err) => process.nextTick(() => done(err)),
      );
  };
}
