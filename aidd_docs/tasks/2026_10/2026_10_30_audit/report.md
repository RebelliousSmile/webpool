# Codebase Audit: webpool (7 piliers)

Base saine et bien découpée, SQL entièrement paramétré, 64 tests verts. Aucun constat critique. Trois sujets dominent : la précision du classifieur (faux positifs vérifiés), la surface réseau (base exposée sur le LAN, SSRF du fetcher) et une suite d'intégration qui s'ignore en silence.

- **Date**: 2026_10_30
- **Scope**: dépôt complet, `main` @ abe4aa3 — code-quality, architecture, security, dependencies, performance, tests, ui
- **Health**: good — aucun constat critique. Les 2 advisories critiques de `pnpm audit` ne touchent que les dépendances de développement (`vitest`) ; elles sont classées warning, voir `dependencies.md`.
- **Findings**: 0 critical, 12 warning, 21 minor

Détail et justification par pilier : `code-quality.md`, `architecture.md`, `security.md`, `dependencies.md`, `performance.md`, `tests.md`, `ui.md`.

## Findings

| Sev | Category     | Location                                 | Issue | Suggested fix | Effort |
| --- | ------------ | ---------------------------------------- | ----- | ------------- | ------ |
| 🟡  | security     | `docker-compose.yml:12`                  | PostgreSQL publié sur `0.0.0.0` (vérifié : `0.0.0.0:5433`) avec les identifiants `webpool`/`webpool` : base accessible depuis le LAN. | Publier en `127.0.0.1:${WEBPOOL_DB_PORT:-5432}:5432`, mot de passe lu dans `.env`. | S |
| 🟡  | security     | `src/normalize/fetcher.js:77`            | SSRF : les URLs venant des SERP ou des fichiers sont récupérées en suivant les redirections, sans filtre (loopback, plages privées, `169.254.169.254`, conteneurs). | Refuser les IP privées après résolution DNS, gérer les redirections manuellement et revalider chaque saut. | M |
| 🟡  | security     | `src/normalize/index.js:20`              | Le `canonical` déclaré par la page est accepté même s'il pointe vers un autre domaine : une page peut usurper l'URL d'un domaine de qualité ou se faire fusionner avec une URL légitime. | Limiter le canonical au même domaine, sinon le garder en simple métadonnée. | S |
| 🟡  | code-quality | `src/classify/classifier.js:8`           | Correspondance par sous-chaîne sans frontière de mot. Vérifié : « Quick build guide » est classé `design` (confiance 1) à cause de `ui` ; `influxdata.com` est classé `design` à cause de `ux` ; `whatsapp.com` est classé `outil` à cause de `app.`. | Comparer par tokens Unicode, ou utiliser une regex avec frontières de mot. | M |
| 🟡  | code-quality | `src/classify/index.js:88`               | `classify --all` reclasse toujours les 100 mêmes premières URLs (`ORDER BY id LIMIT`) : les suivantes ne sont jamais reclassées. | Pagination par curseur, ou boucle jusqu'à épuisement. | S |
| 🟡  | code-quality | `src/ingest/index.js:45`                 | Une URL déjà doublon qui est réingérée voit sa source rattachée à l'item doublon : la requête est perdue pour la classification. | Rattacher à `coalesce(duplicate_of, id)`. | S |
| 🟡  | code-quality | `src/classify/classifier.js:119`         | Les facettes sont calculées avec les requêtes à poids plein (contraire à US-08). Vérifié : avec la requête « forest guide », toute URL devient `tutoriel`. | Calculer les facettes sur le contenu propre de l'URL, ou les pondérer. | S |
| 🟡  | tests        | `test/integration/helpers.js:8`          | `.env` n'est pas chargé : avec `WEBPOOL_DB_PORT=5433`, les 13 tests d'intégration sont ignorés et la commande sort en succès, alors que la base est healthy (vérifié). | Charger `.env`, et échouer au lieu d'ignorer quand `CI` ou `WEBPOOL_IT_REQUIRED` est défini. | S |
| 🟡  | tests        | `package.json:17`                        | Pas de CI : aucune suite n'est exécutée automatiquement. | GitHub Actions avec un service `postgres:17` et les deux suites. | M |
| 🟡  | architecture | `db/init/001_init.sql:1`                 | Le schéma n'est appliqué que sur un volume vide, sans migrations : toute évolution impose `db:reset`, qui détruit le corpus. | Migrations versionnées et commande `webpool migrate`. | M |
| 🟡  | dependencies | `package.json:26`                        | `vitest` 3.2.7 : 12 advisories (2 critiques sur tinypool avec RCE, 3 hautes, 6 modérées, 1 basse), toutes limitées au développement. | `vitest` ≥ 4.1.12 (dernière version : 5.0.5). | M |
| 🟡  | performance  | `src/normalize/index.js:81`              | Tout le lot de pages est gardé en mémoire avant l'écriture en base (environ 2,5 Go possibles avec `--limit 10000`), et le travail est perdu en cas de plantage. | Traiter par blocs. | S |
| 🟢  | code-quality | `bin/webpool.js:57`                      | `--limit` n'est pas validé (`NaN`, valeurs négatives) : erreur PostgreSQL peu lisible. | Exiger un entier strictement positif. | S |
| 🟢  | code-quality | `src/pools/criteria.js:83`               | Un `limit` non numérique donne `NaN` (vérifié), et les types des critères ne sont pas validés. | Valider les types. | S |
| 🟢  | code-quality | `src/config.js:20`                       | Les variables d'environnement numériques ne sont pas validées (`NaN`). | Helper `intEnv`. | S |
| 🟢  | code-quality | `src/ingest/index.js:26`                 | Le patron `startRun`/`finishRun` est copié quatre fois. | Extraire `withRun(kind, detail, fn)`. | S |
| 🟢  | code-quality | `src/ingest/index.js:65`                 | `pendingCount` est exporté mais jamais utilisé. | Le supprimer. | S |
| 🟢  | code-quality | `src/db.js:25`                           | Un `ROLLBACK` qui échoue masque l'erreur d'origine. | `.catch(() => {})` sur le rollback. | S |
| 🟢  | code-quality | `src/pools/index.js:11`                  | `pool create` écrase silencieusement une définition existante. | `--force`, ou sous-commande `pool update`. | S |
| 🟢  | code-quality | `src/config.js:26`                       | La version du User-Agent est codée en dur. | La lire depuis `package.json`. | S |
| 🟢  | architecture | `src/classify/index.js:13`               | La synchronisation de la taxonomie ne fait qu'un upsert : les thèmes retirés restent en base, et un slug enfant en double écrase son parent. | Archiver les thèmes absents du JSON, rejeter les doublons. | M |
| 🟢  | architecture | `src/config.js:12`                       | `config` est un singleton mutable, modifié par les tests. | Passer la taxonomie en paramètre, geler `config`. | S |
| 🟢  | architecture | `bin/webpool.js:40`                      | Du SQL métier (`stats`) est écrit dans la couche CLI. | Le déplacer dans `src/stats.js`. | S |
| 🟢  | security     | `src/config.js:14`                       | La valeur par défaut de `DATABASE_URL` contient un mot de passe en clair et s'applique hors développement. | Exiger la variable hors développement. | S |
| 🟢  | security     | `src/pools/export.js:50`                 | L'export Markdown n'échappe pas le HTML des titres venant du web. | Échapper `<`, `>` et `&`. | S |
| 🟢  | dependencies | `package.json:23`                        | `pg` 8.22.0, alors que la 8.23.1 est sortie. | `pnpm update pg`. | S |
| 🟢  | performance  | `src/ingest/index.js:33`                 | Une transaction et 2 à 3 requêtes par résultat (N+1). | Insert groupé via `unnest`. | S |
| 🟢  | performance  | `src/pools/index.js:32`                  | Jusqu'à 1000 `INSERT` unitaires par refresh. | `INSERT … SELECT`. | S |
| 🟢  | performance  | `src/classify/index.js:48`               | Une transaction et N requêtes par URL classée. | Regrouper par lots. | S |
| 🟢  | performance  | `src/normalize/fetcher.js:63`            | Le délai par hôte n'est pas appliqué après une redirection. | Appeler `throttle` à chaque saut. | S |
| 🟢  | tests        | `bin/webpool.js:50`                      | Le CLI n'est pas testé. | Tests via `execFile`. | M |
| 🟢  | tests        | `test/classifier.test.js:4`              | Aucun test sur la taxonomie réelle ni sur les frontières de mots. | Tests de non-régression (`build`, `influx`, `whatsapp`). | S |
| 🟢  | tests        | `test/integration/pipeline.test.js:44`   | Réingestion d'un doublon et `--all` au-delà de `limit` non couverts. | Ajouter ces deux scénarios avec les corrections. | S |

## Top actions

1. **Fermer la surface réseau** : lier PostgreSQL à `127.0.0.1` (S), ajouter la garde SSRF et la limitation de débit à chaque redirection (M), restreindre le canonical au même domaine (S). Résout : `docker-compose.yml:12`, `fetcher.js:77`, `fetcher.js:63`, `normalize/index.js:20`. Passer par `aidd-dev:01-plan`, puis `aidd-dev:02-implement`.
2. **Fiabiliser le classifieur** : correspondance par mots, facettes non pilotées par les requêtes, tests sur la taxonomie réelle. Résout : `classifier.js:8`, `classifier.js:119`, `classifier.test.js:4`. Passer par `aidd-dev:07-refactor`, puis `aidd-dev:06-test`.
3. **Rendre les tests d'intégration contraignants** : chargement de `.env` dans `helpers.js`, échec au lieu d'un skip silencieux, CI avec PostgreSQL. Résout : `helpers.js:8`, `package.json:17`. Passer par `aidd-dev:06-test`.
4. **Corriger les deux défauts de traçabilité et de reclassement**, avec leurs tests : `ingest/index.js:45`, `classify/index.js:88`, `pipeline.test.js:44`. Passer par `aidd-dev:08-debug`.
5. **Migrations versionnées** avant toute évolution du schéma : `001_init.sql:1`. Ensuite, monter `vitest` d'une version majeure (`package.json:26`).

## Coverage

- **Scanned**: code-quality, architecture (heuristiques de couplage), security, dependencies (`pnpm audit`, `outdated`, `licenses`), performance (heuristiques statiques), tests (les deux suites exécutées : 51/51 et 13/13).
- **Skipped**:
  - ui — aucun frontend (CLI Node), aucune URL fournie.
  - architecture, partie conformité — aucun document d'architecture (`aidd_docs/memory`, ADR, C4).
  - performance, partie mesure — no profiler, static heuristics only.
  - tests, partie couverture chiffrée — no coverage tool, static inspection only.
  - security — `.env.example` n'a pas pu être lu (les permissions locales refusent `.env*`).
