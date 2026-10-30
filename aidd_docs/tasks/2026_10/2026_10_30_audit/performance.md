# Codebase Audit: performance

Aux volumes par défaut (`--limit 100`), rien de bloquant. Les écritures en base sont unitaires (N+1), et la normalisation garde tout un lot en mémoire.

- **Date**: 2026_10_30
- **Scope**: performance — `src/`
- **Health**: good
- **Findings**: 0 critical, 1 warning, 4 minor

## Findings

| Sev | Category    | Location                       | Issue | Suggested fix | Effort |
| --- | ----------- | ------------------------------ | ----- | ------------- | ------ |
| 🟡  | performance | `src/normalize/index.js:81`    | Toutes les pages du lot (jusqu'à `maxBodyBytes` = 256 Ko chacune) sont gardées en mémoire avant la phase d'écriture en base. Avec `--limit 10000`, cela peut aller jusqu'à environ 2,5 Go, et un plantage en cours de lot perd tout le travail réseau déjà fait. | Traiter par blocs, par exemple 100 à la fois (réseau, puis écriture en base), ou n'extraire et ne conserver que `title` et `canonical`. | S |
| 🟢  | performance | `src/ingest/index.js:33`       | Une transaction et 2 à 3 requêtes par résultat de SERP (N+1). | Faire un seul `INSERT … SELECT FROM unnest($1::text[], …) ON CONFLICT` pour les `url_item`, puis un insert groupé des `url_source`. | S |
| 🟢  | performance | `src/pools/index.js:32`        | Jusqu'à 1000 `INSERT` unitaires par rafraîchissement de pool. | `INSERT INTO pool_item SELECT … FROM unnest(...) WITH ORDINALITY`, ou bien `INSERT … SELECT` directement sur la requête de sélection. | S |
| 🟢  | performance | `src/classify/index.js:48`     | Par URL : une transaction, 2 `DELETE` et N `INSERT`. | Regrouper plusieurs items par transaction et faire des inserts multi-lignes. | S |
| 🟢  | performance | `src/normalize/fetcher.js:63`  | Le délai entre deux requêtes vers un même hôte n'est appliqué qu'à l'hôte initial. Les redirections vers un hôte commun (raccourcisseurs, CDN) ne sont pas espacées. | À traiter avec la garde SSRF (redirections manuelles) : appeler `throttle` à chaque saut. | S |

## Top actions

1. Normaliser par blocs, pour borner la mémoire et rendre le traitement reprenable.
2. Grouper les écritures d'ingest et de refresh de pool avec `unnest`.
3. Espacer aussi les requêtes après redirection, en même temps que la garde SSRF.

## Coverage

- **Scanned**: performance par heuristiques statiques. Les requêtes de lecture sont indexées (`url_item_status_idx`, `url_source_item_idx`, clés primaires de `url_theme` et `url_facet_value`), pas de résultats non bornés côté pools (limite ≤ 1000).
- **Skipped**: no profiler, static heuristics only (aucun `EXPLAIN` sur un corpus réel). La taille de bundle est sans objet (CLI Node).
