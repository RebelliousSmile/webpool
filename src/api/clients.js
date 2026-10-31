import crypto from 'node:crypto';
import { query } from '../db.js';

// Clients de l'API : le jeton n'est montré qu'à la création ; la base n'en garde
// que l'empreinte, comparée à chaque requête.
export const SCOPES = ['admin', 'read'];
const TOKEN_PREFIX = 'wp_';

export function generateToken() {
  return `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// En-tête `Authorization: Bearer <jeton>` ; null si absent ou mal formé.
export function bearerToken(header) {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return match ? match[1] : null;
}

function assertScope(scope) {
  if (!SCOPES.includes(scope)) throw new Error(`--scope invalide : "${scope}" (attendu : ${SCOPES.join(', ')})`);
}

export async function addClient({ name, scope = 'read' }) {
  assertScope(scope);
  const token = generateToken();
  const { rows } = await query(
    `INSERT INTO api_client (name, scope, token_hash) VALUES ($1, $2, $3)
     ON CONFLICT (name) DO NOTHING RETURNING id`,
    [name, scope, hashToken(token)],
  );
  if (rows.length === 0) throw new Error(`Client existant : ${name}`);
  return { id: Number(rows[0].id), name, scope, token };
}

export async function listClients() {
  const { rows } = await query(
    `SELECT c.name, c.scope, c.created_at, c.revoked_at,
            coalesce(array_agg(p.slug ORDER BY p.slug) FILTER (WHERE p.slug IS NOT NULL), '{}') AS pools
       FROM api_client c
       LEFT JOIN api_client_pool cp ON cp.api_client_id = c.id
       LEFT JOIN pool p ON p.id = cp.pool_id
      GROUP BY c.id ORDER BY c.name`,
  );
  return rows;
}

export async function revokeClient({ name }) {
  const { rowCount } = await query(
    'UPDATE api_client SET revoked_at = now() WHERE name = $1 AND revoked_at IS NULL',
    [name],
  );
  if (rowCount === 0) throw new Error(`Client inconnu ou déjà révoqué : ${name}`);
  return { name };
}

// Accorde (ou retire) l'accès d'un client à un pool.
export async function setPoolAccess({ name, slug, granted }) {
  const { rows } = await query(
    `SELECT (SELECT id FROM api_client WHERE name = $1) AS client_id,
            (SELECT id FROM pool WHERE slug = $2) AS pool_id`,
    [name, slug],
  );
  const { client_id: clientId, pool_id: poolId } = rows[0];
  if (clientId === null) throw new Error(`Client inconnu : ${name}`);
  if (poolId === null) throw new Error(`Pool inconnu : ${slug}`);
  await query(
    granted
      ? 'INSERT INTO api_client_pool (api_client_id, pool_id) VALUES ($1, $2) ON CONFLICT DO NOTHING'
      : 'DELETE FROM api_client_pool WHERE api_client_id = $1 AND pool_id = $2',
    [clientId, poolId],
  );
  return { name, slug, granted };
}

// Client actif correspondant au jeton, ou null.
export async function authenticate(token) {
  if (!token) return null;
  const { rows } = await query(
    'SELECT id, name, scope FROM api_client WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashToken(token)],
  );
  return rows.length ? { id: Number(rows[0].id), name: rows[0].name, scope: rows[0].scope } : null;
}
