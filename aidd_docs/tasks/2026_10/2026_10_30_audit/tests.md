# Codebase Audit: tests

La pyramide est saine : 51 tests unitaires et 13 tests d'intégration, tous verts. Mais la suite d'intégration s'ignore elle-même en silence, y compris quand la base tourne, et aucune CI ne l'exécute.

- **Date**: 2026_10_30
- **Scope**: tests — `test/`, configurations vitest
- **Health**: good
- **Findings**: 0 critical, 2 warning, 3 minor

## Findings

| Sev | Category | Location                                 | Issue | Suggested fix | Effort |
| --- | -------- | ---------------------------------------- | ----- | ------------- | ------ |
| 🟡  | tests    | `test/integration/helpers.js:8`          | `helpers.js` détermine l'URL de la base sans charger `.env` (seul `src/config.js` le fait). Si la base est sur un autre port (`WEBPOOL_DB_PORT=5433` dans `.env`), `dbAvailable()` échoue et les 13 tests sont ignorés (`pipeline.test.js:5-10`), alors que la commande sort en succès. Vérifié : base healthy sur 5433, `pnpm test:integration` donne « 13 skipped » et un code de sortie 0. | Charger `.env` dans `helpers.js` (`process.loadEnvFile`), et faire échouer la suite au lieu de l'ignorer quand `CI` ou `WEBPOOL_IT_REQUIRED` est défini. | S |
| 🟡  | tests    | `package.json:17`                        | Pas de CI (aucun `.github/workflows`) : ni les tests unitaires ni les tests d'intégration ne sont exécutés automatiquement à chaque push ou PR. | Ajouter un workflow GitHub Actions avec un service `postgres:17`, qui lance `pnpm test` puis `pnpm test:integration`. | M |
| 🟢  | tests    | `bin/webpool.js:50`                      | Le CLI n'est pas testé : analyse des arguments, sous-commandes inconnues, codes de sortie, validation de `--limit`. | Écrire quelques tests qui lancent `node bin/webpool.js` via `execFile` contre le schéma d'intégration. | M |
| 🟢  | tests    | `test/classifier.test.js:4`              | Les tests utilisent une taxonomie de test, jamais `config/taxonomy.json`, et aucun cas ne porte sur les frontières de mots. Ces cas auraient révélé les faux positifs `ui` et `ux` (voir `code-quality.md`). | Ajouter des tests de non-régression sur la taxonomie réelle : `build`, `guide`, `influx`, `whatsapp`. | S |
| 🟢  | tests    | `test/integration/pipeline.test.js:44`   | Deux cas limites ne sont pas couverts : la réingestion d'une URL déjà marquée doublon (sources rattachées à l'item doublon) et `classify --all` au-delà de `limit`. Ce sont justement les deux défauts relevés dans `code-quality.md`. | Ajouter ces deux scénarios en même temps que les corrections. | S |

## Top actions

1. Corriger le chargement de `.env` dans `helpers.js` et faire échouer la suite quand la base est requise. Sans ça, la suite d'intégration paraît verte sans s'exécuter. Correction S.
2. Ajouter une CI GitHub Actions avec un service PostgreSQL.
3. Écrire les tests de non-régression du classifieur et des deux défauts d'ingest et de classify, en même temps que leurs corrections (via `aidd-dev:06-test`).

## Coverage

- **Scanned**: tests — `pnpm test` (51/51 réussis, 6 fichiers) ; `pnpm test:integration` : d'abord 13 tests ignorés sans erreur, puis 13/13 réussis avec `DATABASE_URL` pointant sur le port 5433. Aucun `skip` sans raison, aucun `sleep` instable (seul `setTimeout(5)` est utilisé, dans le test de concurrence de `mapLimit`).
- **Skipped**: no coverage tool, static inspection only (`@vitest/coverage-v8` absent, aucun pourcentage de couverture n'est avancé).
