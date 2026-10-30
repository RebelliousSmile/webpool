-- Domaines nouveaux d'un appel : domain_profile garde le run ingest qui a vu le
-- domaine en premier, search_query_run le run ingest de l'appel. NULL pour
-- l'historique et pour les domaines enregistrés par la normalisation.
ALTER TABLE domain_profile ADD COLUMN first_run_id BIGINT REFERENCES processing_run(id);
ALTER TABLE search_query_run ADD COLUMN ingest_run_id BIGINT REFERENCES processing_run(id);
CREATE INDEX domain_profile_first_run_idx ON domain_profile (first_run_id);
CREATE INDEX search_query_run_ingest_run_idx ON search_query_run (ingest_run_id);
