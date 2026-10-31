-- Le propriétaire d'une communauté est le membre qui a versé le plus de giri
-- au pot (apports `purchase` à son nom) ; ex æquo, tous les premiers le sont.
-- Tant que personne n'a versé, c'est le fondateur désigné par l'admin
-- (`community_member.role = 'owner'`, colonne gardée pour ce seul usage).
-- Seuls comptent les membres actifs : invitation acceptée, client non révoqué.
CREATE VIEW community_standing AS
WITH member AS (
    SELECT cm.community_id, cm.api_client_id, cm.role AS stored_role, cm.monthly_limit,
           (cm.accepted_at IS NOT NULL AND ac.revoked_at IS NULL) AS active,
           coalesce((SELECT sum(e.delta) FROM wallet w JOIN wallet_entry e ON e.wallet_id = w.id
                      WHERE w.community_id = cm.community_id AND e.api_client_id = cm.api_client_id
                        AND e.kind = 'purchase'), 0)::bigint AS contributed
      FROM community_member cm JOIN api_client ac ON ac.id = cm.api_client_id
), ranked AS (
    SELECT member.*,
           coalesce(max(contributed) FILTER (WHERE active) OVER (PARTITION BY community_id), 0) AS top
      FROM member
)
SELECT community_id, api_client_id, stored_role, monthly_limit, active, contributed,
       active AND CASE WHEN top > 0 THEN contributed = top ELSE stored_role = 'owner' END AS is_owner
  FROM ranked;

-- Les apports d'un membre au pot : chemin de la vue.
CREATE INDEX wallet_entry_contribution_idx ON wallet_entry (wallet_id, api_client_id) WHERE kind = 'purchase';
