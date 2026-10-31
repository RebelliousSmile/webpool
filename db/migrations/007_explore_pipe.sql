-- Tuyaux d'exploration : un par étiquette `flot:<slug>`, `defaut` pour les
-- requêtes sans étiquette. `entered_after` est le dernier id de
-- search_query_run à l'entrée dans le tuyau : la référence de pression se
-- recalcule à partir des appels qui suivent, elle n'est pas stockée. Un id et
-- non une date, parce que l'horloge du serveur peut reculer. `entered_at` ne
-- sert qu'à l'affichage. Un seul tuyau courant à la fois.
CREATE TABLE explore_pipe (
    slug          TEXT PRIMARY KEY,
    entered_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    entered_after BIGINT NOT NULL DEFAULT 0,
    is_current    BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX explore_pipe_current_key ON explore_pipe ((true)) WHERE is_current;
