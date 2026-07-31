-- webpool — socle PostgreSQL (US-02 / issue #2)
-- Schéma initial : URLs, sources, taxonomie, facettes, pools, traçabilité.

BEGIN;

-- Trace de chaque exécution du pipeline (ingest, normalize, classify, pool).
CREATE TABLE processing_run (
    id          BIGSERIAL PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('ingest', 'normalize', 'classify', 'pool')),
    detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
    status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
);

-- Une ressource web unique. La déduplication porte sur (domain, canonical_url).
CREATE TABLE url_item (
    id               BIGSERIAL PRIMARY KEY,
    raw_url          TEXT NOT NULL,
    canonical_url    TEXT,
    domain           TEXT,
    title            TEXT,
    http_status      INTEGER,
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'normalized', 'classified', 'duplicate', 'error')),
    duplicate_of     BIGINT REFERENCES url_item(id),
    error            TEXT,
    relevance_score  NUMERIC(4,3) CHECK (relevance_score BETWEEN 0 AND 1),
    confidence_score NUMERIC(4,3) CHECK (confidence_score BETWEEN 0 AND 1),
    quality_score    NUMERIC(4,3) CHECK (quality_score BETWEEN 0 AND 1),
    first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    normalized_at    TIMESTAMPTZ,
    classified_at    TIMESTAMPTZ,
    normalize_run_id BIGINT REFERENCES processing_run(id),
    classify_run_id  BIGINT REFERENCES processing_run(id)
);

CREATE UNIQUE INDEX url_item_raw_url_key ON url_item (raw_url);
-- Une seule URL vivante par (domaine, URL canonique) ; les doublons sont marqués 'duplicate'.
CREATE UNIQUE INDEX url_item_domain_canonical_key
    ON url_item (domain, canonical_url)
    WHERE status <> 'duplicate' AND canonical_url IS NOT NULL;
CREATE INDEX url_item_status_idx ON url_item (status);

-- Chaque découverte d'une URL : requête d'origine, provider, date. Une URL peut
-- avoir plusieurs sources (retrouvée par plusieurs requêtes).
CREATE TABLE url_source (
    id            BIGSERIAL PRIMARY KEY,
    url_item_id   BIGINT NOT NULL REFERENCES url_item(id) ON DELETE CASCADE,
    provider      TEXT NOT NULL,
    query         TEXT NOT NULL,
    serp_rank     INTEGER,
    discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    run_id        BIGINT REFERENCES processing_run(id)
);
CREATE INDEX url_source_item_idx ON url_source (url_item_id);
CREATE INDEX url_source_query_idx ON url_source (provider, query);

-- Taxonomie hiérarchique : thèmes racines et sous-thèmes via parent_id.
CREATE TABLE theme (
    id        BIGSERIAL PRIMARY KEY,
    slug      TEXT NOT NULL UNIQUE,
    label     TEXT NOT NULL,
    parent_id BIGINT REFERENCES theme(id)
);

CREATE TABLE url_theme (
    url_item_id BIGINT NOT NULL REFERENCES url_item(id) ON DELETE CASCADE,
    theme_id    BIGINT NOT NULL REFERENCES theme(id) ON DELETE CASCADE,
    is_primary  BOOLEAN NOT NULL DEFAULT FALSE,
    score       NUMERIC(6,3),
    PRIMARY KEY (url_item_id, theme_id)
);
-- Un seul thème principal par URL.
CREATE UNIQUE INDEX url_theme_one_primary ON url_theme (url_item_id) WHERE is_primary;

-- Facettes d'usage (type de contenu, licence, langue…), une valeur par facette et par URL.
CREATE TABLE facet_definition (
    id    BIGSERIAL PRIMARY KEY,
    slug  TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL
);

CREATE TABLE url_facet_value (
    url_item_id BIGINT NOT NULL REFERENCES url_item(id) ON DELETE CASCADE,
    facet_id    BIGINT NOT NULL REFERENCES facet_definition(id) ON DELETE CASCADE,
    value       TEXT NOT NULL,
    PRIMARY KEY (url_item_id, facet_id)
);

-- Pool matérialisé : la définition JSONB est lisible et réexécutable (US-06).
CREATE TABLE pool (
    id             BIGSERIAL PRIMARY KEY,
    slug           TEXT NOT NULL UNIQUE,
    label          TEXT NOT NULL,
    definition     JSONB NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    refreshed_at   TIMESTAMPTZ,
    refresh_run_id BIGINT REFERENCES processing_run(id)
);

CREATE TABLE pool_item (
    pool_id     BIGINT NOT NULL REFERENCES pool(id) ON DELETE CASCADE,
    url_item_id BIGINT NOT NULL REFERENCES url_item(id) ON DELETE CASCADE,
    rank        INTEGER NOT NULL,
    score       NUMERIC(6,3),
    PRIMARY KEY (pool_id, url_item_id),
    UNIQUE (pool_id, rank)
);

COMMIT;
