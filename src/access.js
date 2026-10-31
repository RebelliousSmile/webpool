// Règles d'accès partagées par l'API et les recherches payantes : un seul
// fragment SQL décide quels pools un client voit.
//
// Un client voit un pool s'il est public, s'il lui est accordé, ou s'il
// appartient à une communauté dont il est membre ayant accepté son
// invitation. `pool` est l'alias SQL de la table pool, `client` le paramètre
// de l'id du client (ex. '$3').
export const poolGrantedSql = (pool, client) => `(${pool}.public
         OR EXISTS (SELECT 1 FROM api_client_pool acp WHERE acp.pool_id = ${pool}.id AND acp.api_client_id = ${client})
         OR EXISTS (SELECT 1 FROM community_pool cpv JOIN community_member cmv ON cmv.community_id = cpv.community_id
                     WHERE cpv.pool_id = ${pool}.id AND cmv.api_client_id = ${client} AND cmv.accepted_at IS NOT NULL))`;

// Membre actif : invitation acceptée (les membres ajoutés par l'admin le sont d'office).
export const ACTIVE_MEMBER = 'cm.accepted_at IS NOT NULL';
