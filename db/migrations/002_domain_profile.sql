-- Registre des domaines : une ligne par domaine découvert, qualifiée une fois
-- pour toutes (usage commercial), et la requête qui l'a fait connaître.
CREATE TABLE domain_profile (
    domain           TEXT PRIMARY KEY,
    first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    first_query      TEXT,
    -- NULL : à qualifier
    usage_commercial TEXT CHECK (usage_commercial IN ('libre', 'sous-conditions', 'payant', 'non-commercial')),
    note             TEXT,
    reviewed_at      TIMESTAMPTZ,
    explore_excluded BOOLEAN NOT NULL DEFAULT false
);

-- Domaines déjà normalisés : première découverte reprise de url_source (les
-- sources des doublons sont déjà rattachées aux survivantes).
INSERT INTO domain_profile (domain, first_seen_at, first_query)
SELECT DISTINCT ON (ui.domain) ui.domain, coalesce(us.discovered_at, ui.first_seen_at), us.query
  FROM url_item ui
  LEFT JOIN url_source us ON us.url_item_id = ui.id
 WHERE ui.domain IS NOT NULL AND ui.status <> 'duplicate'
 ORDER BY ui.domain, coalesce(us.discovered_at, ui.first_seen_at), us.id;
