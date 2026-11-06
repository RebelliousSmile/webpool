import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { query } from '../db.js';
import { generateToken, hashToken } from './clients.js';

// Comptes : e-mail et mot de passe pour un client `read`. Pas d'inscription
// libre : l'admin invite (`webpool account invite`), le compte choisit son mot
// de passe avec le code reçu, puis se connecte et obtient un jeton de session.
// Codes et jetons ne sont stockés que par leur empreinte SHA-256 ; le mot de
// passe par scrypt (node:crypto, sans dépendance).

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32;

export const SESSION_PREFIX = 'wps_';
const INVITE_PREFIX = 'wpi_';
export const SESSION_DAYS = 30;
export const INVITE_DAYS = 7;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 200;
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

// Empreinte « scrypt$N$r$p$sel$clé », sel et clé en base64url.
export async function hashPassword(password, { N, r, p } = SCRYPT) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const expected = Buffer.from(parts[5], 'base64url');
  const key = await scrypt(password, Buffer.from(parts[4], 'base64url'), expected.length, { N, r, p });
  return crypto.timingSafeEqual(key, expected);
}

// Empreinte factice : un e-mail inconnu coûte le même calcul qu'un vrai compte,
// sa non-existence ne se lit pas dans le temps de réponse.
let dummyHash;
const dummy = async () => (dummyHash ??= await hashPassword(crypto.randomBytes(16).toString('hex')));

export const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();

export function validEmail(email) {
  return email.length <= EMAIL_MAX && EMAIL_RE.test(email);
}

// Message d'erreur si le mot de passe ne convient pas, sinon null.
export function passwordProblem(password) {
  if (typeof password !== 'string') return 'password attendu (texte)';
  if (password.length < PASSWORD_MIN) return `Mot de passe trop court : ${PASSWORD_MIN} caractères au moins`;
  if (password.length > PASSWORD_MAX) return `Mot de passe trop long : ${PASSWORD_MAX} caractères au plus`;
  return null;
}

// Invite un compte : crée le client `read` s'il n'existe pas, ou rattache
// l'e-mail à un client existant. Une nouvelle invitation vaut réinitialisation :
// mot de passe effacé, sessions révoquées. Le code n'est montré qu'ici.
export async function inviteAccount({ name, email, days = INVITE_DAYS }) {
  const address = normalizeEmail(email);
  if (!validEmail(address)) throw new Error(`E-mail invalide : "${email}"`);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('--days doit être un entier entre 1 et 90');
  const code = `${INVITE_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;

  const { rows: taken } = await query('SELECT name FROM api_client WHERE lower(email) = $1 AND name <> $2', [address, name]);
  if (taken.length) throw new Error(`E-mail déjà rattaché au client ${taken[0].name}`);

  const { rows: existing } = await query('SELECT id, scope, revoked_at FROM api_client WHERE name = $1', [name]);
  let id;
  let created = false;
  if (existing.length) {
    const c = existing[0];
    if (c.scope !== 'read') throw new Error(`Client ${name} : seul un client read peut avoir un compte`);
    if (c.revoked_at) throw new Error(`Client révoqué : ${name}`);
    id = Number(c.id);
  } else {
    // Jeton brut jamais montré : le compte se connecte par mot de passe.
    const { rows } = await query(
      "INSERT INTO api_client (name, scope, token_hash) VALUES ($1, 'read', $2) RETURNING id",
      [name, hashToken(generateToken())],
    );
    id = Number(rows[0].id);
    created = true;
  }
  const { rows } = await query(
    `UPDATE api_client
        SET email = $2, password_hash = NULL, invite_hash = $3,
            invite_expires_at = now() + make_interval(days => $4)
      WHERE id = $1 RETURNING invite_expires_at`,
    [id, address, hashToken(code), days],
  );
  await query('UPDATE api_session SET revoked_at = now() WHERE api_client_id = $1 AND revoked_at IS NULL', [id]);
  return { name, email: address, code, expires_at: rows[0].invite_expires_at.toISOString(), created };
}

async function openSession(clientId) {
  const token = `${SESSION_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  // Ménage : les sessions expirées de ce compte n'ont plus d'usage.
  await query('DELETE FROM api_session WHERE api_client_id = $1 AND expires_at < now()', [clientId]);
  const { rows } = await query(
    `INSERT INTO api_session (api_client_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3)) RETURNING expires_at`,
    [clientId, hashToken(token), SESSION_DAYS],
  );
  return { token, expires_at: rows[0].expires_at.toISOString() };
}

// Premier mot de passe, avec le code d'invitation : session ouverte, ou null
// (e-mail, code ou délai invalide : la cause n'est pas révélée).
export async function activateAccount({ email, code, password }) {
  const { rows } = await query(
    `UPDATE api_client
        SET password_hash = $3, invite_hash = NULL, invite_expires_at = NULL
      WHERE lower(email) = $1 AND invite_hash = $2 AND invite_expires_at > now() AND revoked_at IS NULL
      RETURNING id`,
    [normalizeEmail(email), hashToken(String(code ?? '')), await hashPassword(password)],
  );
  return rows.length ? openSession(Number(rows[0].id)) : null;
}

export async function login({ email, password }) {
  const { rows } = await query(
    `SELECT id, password_hash FROM api_client
      WHERE lower(email) = $1 AND password_hash IS NOT NULL AND revoked_at IS NULL`,
    [normalizeEmail(email)],
  );
  if (!rows.length) {
    await verifyPassword(String(password), await dummy());
    return null;
  }
  if (!(await verifyPassword(String(password), rows[0].password_hash))) return null;
  return openSession(Number(rows[0].id));
}

export async function logout({ sessionId }) {
  if (sessionId) await query('UPDATE api_session SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

// Change le mot de passe et révoque toutes les autres sessions du compte.
// Renvoie false si le mot de passe actuel ne correspond pas ; null sans compte.
export async function changePassword({ clientId, sessionId = null, current, password }) {
  const { rows } = await query('SELECT password_hash FROM api_client WHERE id = $1', [clientId]);
  if (!rows[0]?.password_hash) return null;
  if (!(await verifyPassword(String(current ?? ''), rows[0].password_hash))) return false;
  await query('UPDATE api_client SET password_hash = $2 WHERE id = $1', [clientId, await hashPassword(password)]);
  await query(
    `UPDATE api_session SET revoked_at = now()
      WHERE api_client_id = $1 AND id IS DISTINCT FROM $2 AND revoked_at IS NULL`,
    [clientId, sessionId],
  );
  return true;
}

// Client d'une session active (non expirée, non révoquée, client actif), ou null.
export async function sessionClient(token) {
  const { rows } = await query(
    `SELECT c.id, c.name, c.scope, c.email, s.id AS session_id
       FROM api_session s JOIN api_client c ON c.id = s.api_client_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND c.revoked_at IS NULL`,
    [hashToken(token)],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return { id: Number(r.id), name: r.name, scope: r.scope, email: r.email, sessionId: Number(r.session_id) };
}
