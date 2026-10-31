-- Recherches payantes : les pools restent gratuits ; une recherche (appel à un
-- provider) se paie d'avance en giri, unité interne entière. Un particulier
-- crédite son portefeuille par un don, une communauté le sien par un achat ;
-- les membres dépensent celui de la communauté pour ses pools.
ALTER TABLE processing_run DROP CONSTRAINT processing_run_kind_check;
ALTER TABLE processing_run ADD CONSTRAINT processing_run_kind_check
    CHECK (kind IN ('ingest', 'normalize', 'classify', 'pool', 'explore', 'media', 'request'));

CREATE TABLE community (
    id         BIGSERIAL PRIMARY KEY,
    slug       TEXT NOT NULL UNIQUE,
    label      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- `owner` voit le grand livre et toutes les recherches de la communauté.
-- `monthly_limit` : giri dépensables par le membre sur 30 jours glissants (NULL : sans plafond).
CREATE TABLE community_member (
    community_id  BIGINT NOT NULL REFERENCES community(id) ON DELETE CASCADE,
    api_client_id BIGINT NOT NULL REFERENCES api_client(id) ON DELETE CASCADE,
    role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    monthly_limit BIGINT CHECK (monthly_limit >= 0),
    joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, api_client_id)
);
CREATE INDEX community_member_client_idx ON community_member (api_client_id);

-- Pools de la communauté : visibles par ses membres, seuls pools que son
-- portefeuille peut viser.
CREATE TABLE community_pool (
    community_id BIGINT NOT NULL REFERENCES community(id) ON DELETE CASCADE,
    pool_id      BIGINT NOT NULL REFERENCES pool(id) ON DELETE CASCADE,
    PRIMARY KEY (community_id, pool_id)
);
CREATE INDEX community_pool_pool_idx ON community_pool (pool_id);

-- Un portefeuille appartient à un client ou à une communauté. Le solde est la
-- somme des écritures ; il est tenu à jour dans la même transaction qu'elles
-- pour que le débit soit un UPDATE conditionnel.
CREATE TABLE wallet (
    id            BIGSERIAL PRIMARY KEY,
    api_client_id BIGINT UNIQUE REFERENCES api_client(id) ON DELETE CASCADE,
    community_id  BIGINT UNIQUE REFERENCES community(id) ON DELETE CASCADE,
    balance       BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((api_client_id IS NULL) <> (community_id IS NULL))
);

CREATE TABLE search_request (
    id            BIGSERIAL PRIMARY KEY,
    api_client_id BIGINT NOT NULL REFERENCES api_client(id) ON DELETE CASCADE,
    wallet_id     BIGINT NOT NULL REFERENCES wallet(id) ON DELETE CASCADE,
    pool_id       BIGINT REFERENCES pool(id) ON DELETE SET NULL,
    provider      TEXT NOT NULL,
    query         TEXT NOT NULL,
    pages         INTEGER NOT NULL CHECK (pages >= 1),
    -- prix d'un appel, figé à l'achat
    unit_price    BIGINT NOT NULL CHECK (unit_price >= 1),
    price         BIGINT NOT NULL CHECK (price >= 1),
    refunded      BIGINT NOT NULL DEFAULT 0 CHECK (refunded >= 0 AND refunded <= price),
    status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
    calls_done    INTEGER NOT NULL DEFAULT 0,
    results       INTEGER NOT NULL DEFAULT 0,
    new_urls      INTEGER NOT NULL DEFAULT 0,
    new_domains   INTEGER NOT NULL DEFAULT 0,
    in_pool       INTEGER,
    -- coût réel quand le provider le donne (OpenRouter), estimation sinon
    cost_usd      NUMERIC(12, 6) NOT NULL DEFAULT 0,
    error         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ
);
CREATE INDEX search_request_client_idx ON search_request (api_client_id, id DESC);
CREATE INDEX search_request_wallet_idx ON search_request (wallet_id, id DESC);
CREATE INDEX search_request_queued_idx ON search_request (id) WHERE status IN ('queued', 'running');

-- Grand livre : chaque mouvement de giri. `reference` (paiement reçu) est
-- unique : un même paiement n'est crédité qu'une fois.
CREATE TABLE wallet_entry (
    id                BIGSERIAL PRIMARY KEY,
    wallet_id         BIGINT NOT NULL REFERENCES wallet(id) ON DELETE CASCADE,
    delta             BIGINT NOT NULL CHECK (delta <> 0),
    kind              TEXT NOT NULL CHECK (kind IN ('donation', 'purchase', 'debit', 'refund', 'adjustment')),
    amount_cents      INTEGER CHECK (amount_cents > 0),
    reference         TEXT UNIQUE,
    search_request_id BIGINT REFERENCES search_request(id) ON DELETE SET NULL,
    -- client qui dépense (débit) ; NULL pour un crédit saisi par l'admin
    api_client_id     BIGINT REFERENCES api_client(id) ON DELETE SET NULL,
    note              TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX wallet_entry_wallet_idx ON wallet_entry (wallet_id, id DESC);

-- Recherche qui a trouvé l'URL : suivie par la normalisation, qui reporte les
-- sources d'un doublon sur l'URL survivante.
ALTER TABLE url_source ADD COLUMN search_request_id BIGINT REFERENCES search_request(id) ON DELETE SET NULL;
CREATE INDEX url_source_request_idx ON url_source (search_request_id) WHERE search_request_id IS NOT NULL;
