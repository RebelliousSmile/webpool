-- Recherches payantes, suites de l'audit du 2026-10-31.

-- Idempotence de l'achat : un même client qui renvoie la même clé (double clic,
-- relance après une coupure) retrouve sa recherche au lieu d'être débité deux fois.
ALTER TABLE search_request ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX search_request_idempotency_key ON search_request (api_client_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Post-traitement (normalize, classify, refresh des pools visés) fait : une
-- recherche `done` sans cette date est reprise par le `requests run` suivant.
ALTER TABLE search_request ADD COLUMN processed_at TIMESTAMPTZ;
UPDATE search_request SET processed_at = finished_at WHERE status IN ('done', 'failed', 'cancelled');

-- Catégorie d'erreur (provider, interrupted, internal) : le client voit un
-- message générique, l'admin le message brut (`error`).
ALTER TABLE search_request ADD COLUMN error_kind TEXT
    CHECK (error_kind IN ('provider', 'interrupted', 'internal'));
UPDATE search_request SET error_kind = CASE WHEN error = 'exécution interrompue' THEN 'interrupted' ELSE 'provider' END
 WHERE error IS NOT NULL;

-- `in_pool` se calcule à la lecture : la colonne se figeait (jamais mise à
-- jour par cycle ni pool refresh).
ALTER TABLE search_request DROP COLUMN in_pool;

-- Invitation : un propriétaire inscrit un client, qui doit accepter ; sans
-- acceptation, ni pools ni pot commun. Les membres existants sont acceptés.
ALTER TABLE community_member ADD COLUMN accepted_at TIMESTAMPTZ;
UPDATE community_member SET accepted_at = joined_at;

-- Index des chemins chauds relevés par l'audit (EXPLAIN sur 550 000 écritures).
CREATE INDEX wallet_entry_member_spend_idx ON wallet_entry (wallet_id, api_client_id, created_at)
    WHERE kind IN ('debit', 'refund');
CREATE INDEX wallet_entry_request_idx ON wallet_entry (search_request_id) WHERE search_request_id IS NOT NULL;
CREATE INDEX wallet_entry_client_idx ON wallet_entry (api_client_id) WHERE api_client_id IS NOT NULL;
CREATE INDEX wallet_entry_credit_idx ON wallet_entry (created_at) WHERE kind IN ('donation', 'purchase');
CREATE INDEX search_request_pool_idx ON search_request (pool_id) WHERE pool_id IS NOT NULL;
