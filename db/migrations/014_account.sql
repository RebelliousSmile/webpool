-- Comptes : un client `read` peut avoir un e-mail et un mot de passe (haché
-- scrypt), choisi grâce à un code d'invitation à usage unique remis par
-- l'admin (`webpool account invite`). Pas d'inscription libre. La connexion
-- ouvre une session de 30 jours, dont seule l'empreinte du jeton est stockée.
ALTER TABLE api_client
    ADD COLUMN email             TEXT,
    ADD COLUMN password_hash     TEXT,
    ADD COLUMN invite_hash       TEXT UNIQUE,
    ADD COLUMN invite_expires_at TIMESTAMPTZ;
CREATE UNIQUE INDEX api_client_email_idx ON api_client (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE api_session (
    id            BIGSERIAL PRIMARY KEY,
    api_client_id BIGINT NOT NULL REFERENCES api_client(id) ON DELETE CASCADE,
    token_hash    TEXT NOT NULL UNIQUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL,
    revoked_at    TIMESTAMPTZ
);
CREATE INDEX api_session_client_idx ON api_session (api_client_id);
