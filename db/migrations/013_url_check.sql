-- Contrôle des liens (`webpool check`, étape du cycle) : chaque test du statut
-- HTTP final d'un lien est historisé ; trois échecs francs consécutifs mettent
-- le lien en quarantaine (exclu des pools, jamais supprimé), un succès l'en sort.
CREATE TABLE url_check (
    id            BIGSERIAL PRIMARY KEY,
    url_item_id   BIGINT NOT NULL REFERENCES url_item(id) ON DELETE CASCADE,
    checked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    http_status   INTEGER,
    verdict       TEXT NOT NULL CHECK (verdict IN ('ok', 'dead', 'unsure')),
    -- étiquette courte : HOST_REFUSED, TOO_MANY_REDIRECTS, code (ENOTFOUND…) ou nom (TimeoutError)
    error         TEXT,
    final_url     TEXT,
    run_id        BIGINT REFERENCES processing_run(id) ON DELETE SET NULL
);
CREATE INDEX url_check_item_idx ON url_check (url_item_id, checked_at DESC);
CREATE INDEX url_check_checked_at_idx ON url_check (checked_at);

ALTER TABLE url_item
    ADD COLUMN checked_at     TIMESTAMPTZ,
    ADD COLUMN dead_streak    INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN quarantined_at TIMESTAMPTZ;

-- Liens à tester : les moins récemment testés d'abord.
CREATE INDEX url_item_check_idx ON url_item (checked_at NULLS FIRST, id)
    WHERE status IN ('normalized', 'classified');

ALTER TABLE processing_run DROP CONSTRAINT processing_run_kind_check;
ALTER TABLE processing_run ADD CONSTRAINT processing_run_kind_check
    CHECK (kind IN ('ingest', 'normalize', 'classify', 'pool', 'explore', 'media', 'request', 'check'));
