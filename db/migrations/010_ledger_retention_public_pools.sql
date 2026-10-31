-- Grand livre conservé : un client ou une communauté qui a un portefeuille ne
-- se supprime plus en cascade avec ses écritures (pièces comptables gardées
-- 10 ans) ; on révoque le client. 009 est publiée : correction par une
-- nouvelle migration.
ALTER TABLE wallet DROP CONSTRAINT wallet_api_client_id_fkey;
ALTER TABLE wallet ADD CONSTRAINT wallet_api_client_id_fkey
    FOREIGN KEY (api_client_id) REFERENCES api_client(id) ON DELETE RESTRICT;
ALTER TABLE wallet DROP CONSTRAINT wallet_community_id_fkey;
ALTER TABLE wallet ADD CONSTRAINT wallet_community_id_fkey
    FOREIGN KEY (community_id) REFERENCES community(id) ON DELETE RESTRICT;
ALTER TABLE search_request DROP CONSTRAINT search_request_api_client_id_fkey;
ALTER TABLE search_request ADD CONSTRAINT search_request_api_client_id_fkey
    FOREIGN KEY (api_client_id) REFERENCES api_client(id) ON DELETE RESTRICT;
ALTER TABLE search_request DROP CONSTRAINT search_request_wallet_id_fkey;
ALTER TABLE search_request ADD CONSTRAINT search_request_wallet_id_fkey
    FOREIGN KEY (wallet_id) REFERENCES wallet(id) ON DELETE RESTRICT;
ALTER TABLE wallet_entry DROP CONSTRAINT wallet_entry_wallet_id_fkey;
ALTER TABLE wallet_entry ADD CONSTRAINT wallet_entry_wallet_id_fkey
    FOREIGN KEY (wallet_id) REFERENCES wallet(id) ON DELETE RESTRICT;

-- Pool public : visible et exportable par tout client authentifié, sans accord.
ALTER TABLE pool ADD COLUMN public BOOLEAN NOT NULL DEFAULT false;
