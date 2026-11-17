-- Listes de liens soumises par les membres d'une communauté : une recherche
-- du provider virtuel `list`, dont les « résultats » sont ces liens
-- ([{url, title}], validés à la soumission). Même file, même examen
-- (normalize, classify, media), mêmes règles d'entrée dans le pool que les
-- recherches des providers.
ALTER TABLE search_request ADD COLUMN links JSONB;
ALTER TABLE search_request ADD CONSTRAINT search_request_list_links
    CHECK ((provider = 'list') = (links IS NOT NULL));
