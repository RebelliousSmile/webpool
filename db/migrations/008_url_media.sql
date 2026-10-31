-- Médias des liens (phase 3) : métadonnées lues dans le <head> à la
-- normalisation, vignettes et favicons mis en cache par `webpool media`.

ALTER TABLE url_item
    ADD COLUMN description TEXT,
    -- NULL : URL normalisée avant cette migration, le type se déduit de l'URL
    ADD COLUMN media_type  TEXT CHECK (media_type IN ('page', 'image', 'video', 'pdf', 'data', 'code', 'model')),
    ADD COLUMN lang        TEXT,
    ADD COLUMN site_name   TEXT;

-- Une vignette candidate par origine : `og` (la page, ou l'URL elle-même si
-- c'est une image), `provider` (vignette fournie par le moteur de recherche).
-- `file` : empreinte du WebP produit, nom du fichier dans WEBPOOL_MEDIA_DIR.
CREATE TABLE url_media (
    url_item_id BIGINT NOT NULL REFERENCES url_item(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('og', 'provider')),
    source_url  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'cached', 'failed')),
    file        TEXT,
    width       INTEGER,
    height      INTEGER,
    bytes       INTEGER,
    error       TEXT,
    fetched_at  TIMESTAMPTZ,
    PRIMARY KEY (url_item_id, kind)
);
CREATE INDEX url_media_pending_idx ON url_media (status) WHERE status = 'pending';

-- Favicon : une source par domaine, découverte à la normalisation.
ALTER TABLE domain_profile
    ADD COLUMN favicon_source     TEXT,
    ADD COLUMN favicon_status     TEXT CHECK (favicon_status IN ('pending', 'cached', 'failed')),
    ADD COLUMN favicon_file       TEXT,
    ADD COLUMN favicon_error      TEXT,
    ADD COLUMN favicon_fetched_at TIMESTAMPTZ;

ALTER TABLE processing_run DROP CONSTRAINT processing_run_kind_check;
ALTER TABLE processing_run ADD CONSTRAINT processing_run_kind_check
    CHECK (kind IN ('ingest', 'normalize', 'classify', 'pool', 'explore', 'media'));
