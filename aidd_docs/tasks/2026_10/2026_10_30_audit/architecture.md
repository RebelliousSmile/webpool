# Codebase Audit: architecture

Les couches sont propres (`bin` → modules → `db`, fonctions pures isolées, providers à contrat commun). Le vrai risque est l'absence de migrations du schéma.

- **Date**: 2026_10_30
- **Scope**: architecture — structure des modules, schéma, couplage
- **Health**: good
- **Findings**: 0 critical, 1 warning, 3 minor

## Findings

| Sev | Category     | Location                     | Issue | Suggested fix | Effort |
| --- | ------------ | ---------------------------- | ----- | ------------- | ------ |
| 🟡  | architecture | `db/init/001_init.sql:1`     | Le schéma n'est appliqué que par `docker-entrypoint-initdb.d`, c'est-à-dire seulement sur un volume vide. Il n'y a aucun mécanisme de migration : toute évolution du schéma impose `db:reset`, qui détruit le corpus. | Versionner les migrations (`db/migrations/NNN_*.sql`, table `schema_migrations`, commande `webpool migrate`). | M |
| 🟢  | architecture | `src/classify/index.js:13`   | Le JSON est présenté comme source de vérité, mais la synchronisation n'est qu'un upsert : un thème ou une facette retiré du JSON reste en base, et les anciennes affectations `url_theme` des URLs non reclassées restent en place. Un slug enfant identique à un slug racine écrase aussi ce parent. | Marquer comme obsolètes, ou supprimer, les thèmes absents du JSON. Rejeter les slugs dupliqués au chargement de la taxonomie. | M |
| 🟢  | architecture | `src/config.js:12`           | `config` est un singleton mutable partagé par tous les modules, et les tests le modifient (`test/integration/pipeline.test.js:145`). C'est un couplage global caché. | Passer `taxonomyPath` ou `taxonomy` en paramètre de `classifyPending`, et geler `config`. | S |
| 🟢  | architecture | `bin/webpool.js:40`          | La fonction `stats()` exécute du SQL métier directement dans la couche CLI, alors que les autres commandes délèguent à `src/`. | La déplacer dans un module `src/stats.js`. | S |

## Top actions

1. Introduire des migrations versionnées avant la prochaine évolution du schéma, pour éviter de perdre le corpus. Passer par `aidd-dev:01-plan`.
2. Rendre la synchronisation de la taxonomie vraiment conforme au JSON : suppression ou archivage des thèmes retirés, rejet des slugs en double.
3. Faire passer la configuration en paramètre plutôt qu'en singleton mutable. C'est l'occasion de nettoyer les tests.

## Coverage

- **Scanned**: architecture, par heuristiques de couplage observables : graphe d'imports `bin` → `src/*` → `db.js` et `run.js`, aucun cycle ; schéma SQL.
- **Skipped**: conformité aux documents d'architecture. Aucun document trouvé (pas d'`aidd_docs/memory`, d'ADR ni de C4) : vérification de conformité ignorée.
