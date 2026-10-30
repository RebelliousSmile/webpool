-- Frontière d'exploration : requêtes à relancer page après page, avec le
-- rendement de chaque passage. La priorité se calcule à la sélection.
ALTER TABLE processing_run DROP CONSTRAINT processing_run_kind_check;
ALTER TABLE processing_run ADD CONSTRAINT processing_run_kind_check
    CHECK (kind IN ('ingest', 'normalize', 'classify', 'pool', 'explore'));

CREATE TABLE search_query (
    id           BIGSERIAL PRIMARY KEY,
    provider     TEXT NOT NULL,
    query        TEXT NOT NULL,
    tags         TEXT[] NOT NULL DEFAULT '{}',
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'exhausted', 'paused')),
    next_page    INTEGER NOT NULL DEFAULT 0 CHECK (next_page >= 0),
    runs         INTEGER NOT NULL DEFAULT 0,
    -- passages consécutifs sans URL nouvelle
    dry_runs     INTEGER NOT NULL DEFAULT 0,
    last_run_at  TIMESTAMPTZ,
    exhausted_at TIMESTAMPTZ,
    origin       TEXT NOT NULL DEFAULT 'seed' CHECK (origin IN ('seed', 'generated')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, query)
);

-- Un appel au provider : rendement, ou erreur (la page n'avance pas).
CREATE TABLE search_query_run (
    id              BIGSERIAL PRIMARY KEY,
    search_query_id BIGINT NOT NULL REFERENCES search_query(id) ON DELETE CASCADE,
    page            INTEGER NOT NULL,
    results         INTEGER NOT NULL DEFAULT 0,
    new_urls        INTEGER NOT NULL DEFAULT 0,
    new_domains     INTEGER NOT NULL DEFAULT 0,
    error           TEXT,
    run_id          BIGINT REFERENCES processing_run(id),
    ran_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX search_query_run_query_idx ON search_query_run (search_query_id);
