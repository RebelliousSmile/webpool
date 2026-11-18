-- Récompense des liens valides : qui apporte, par une liste payée par une
-- communauté, un lien nouveau pour le corpus qui entre dans le pool visé gagne
-- des giri sur son portefeuille personnel. Une récompense par URL, à vie.
ALTER TABLE wallet_entry DROP CONSTRAINT wallet_entry_kind_check;
ALTER TABLE wallet_entry ADD CONSTRAINT wallet_entry_kind_check
    CHECK (kind IN ('donation', 'purchase', 'debit', 'refund', 'adjustment', 'reward'));

CREATE TABLE link_reward (
    url_item_id       BIGINT PRIMARY KEY REFERENCES url_item(id) ON DELETE RESTRICT,
    search_request_id BIGINT NOT NULL REFERENCES search_request(id) ON DELETE RESTRICT,
    api_client_id     BIGINT NOT NULL REFERENCES api_client(id) ON DELETE RESTRICT,
    domain            TEXT NOT NULL,
    giri              BIGINT NOT NULL CHECK (giri > 0),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Plafonds sur 30 jours : par membre, et par membre et domaine.
CREATE INDEX link_reward_client_idx ON link_reward (api_client_id, created_at);
CREATE INDEX link_reward_client_domain_idx ON link_reward (api_client_id, domain, created_at);
CREATE INDEX link_reward_request_idx ON link_reward (search_request_id);

-- Total gagné par une recherche (liste).
ALTER TABLE search_request ADD COLUMN rewarded BIGINT NOT NULL DEFAULT 0 CHECK (rewarded >= 0);
