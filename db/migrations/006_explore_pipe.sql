-- Tuyaux d'exploration : un par étiquette `flot:<slug>`, `defaut` pour les
-- requêtes sans étiquette. `entered_at` date l'entrée dans le tuyau : la
-- référence de pression se recalcule à partir des appels qui suivent, elle
-- n'est pas stockée. Un seul tuyau courant à la fois.
CREATE TABLE explore_pipe (
    slug       TEXT PRIMARY KEY,
    entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_current BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX explore_pipe_current_key ON explore_pipe ((true)) WHERE is_current;
