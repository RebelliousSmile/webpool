-- Clients de l'API HTTP (webpool serve) : une clé par client, dont seule
-- l'empreinte SHA-256 est stockée. `admin` voit tout ; `read` ne voit que les
-- pools qui lui sont accordés, sans leurs définitions ni leurs scores.
CREATE TABLE api_client (
    id         BIGSERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    scope      TEXT NOT NULL CHECK (scope IN ('admin', 'read')),
    token_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);

CREATE TABLE api_client_pool (
    api_client_id BIGINT NOT NULL REFERENCES api_client(id) ON DELETE CASCADE,
    pool_id       BIGINT NOT NULL REFERENCES pool(id) ON DELETE CASCADE,
    granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (api_client_id, pool_id)
);
