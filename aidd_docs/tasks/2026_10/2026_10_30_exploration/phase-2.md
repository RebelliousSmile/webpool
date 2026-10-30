---
status: pending
---

<!-- Fill or omit these sections; never add, rename, or reorder one. -->

# Instruction: Frontière de requêtes, pagination et commande `explore`

## Architecture projection

> Tree of the final files. ✅ create · ✏️ modify · ❌ delete

```txt
.
├── db/migrations/
│   └── 003_search_query.sql          ✅ search_query (provider, query, tags, status, next_page, runs, last_run_at, exhausted_at, origin) + search_query_run (rendement par passage) ; processing_run accepte le type explore
├── src/
│   ├── explore/
│   │   ├── frontier.js               ✅ fonctions pures : priorité, page suivante, épuisement, retour après repos
│   │   └── index.js                  ✅ addQueries, importQueries, listQueries, explore
│   ├── ingest/index.js               ✏️ accepte page, renvoie newDomains (les lignes insérées au registre par la phase 1)
│   ├── ingest/providers/brave.js     ✏️ offset = page (0 à 9)
│   ├── ingest/providers/searxng.js   ✏️ pageno = page + 1
│   ├── ingest/providers/flickr.js    ✏️ page = page + 1
│   ├── ingest/providers/europeana.js ✏️ start = page × rows + 1
│   └── config.js                     ✏️ WEBPOOL_EXPLORE_REST_DAYS (30), WEBPOOL_EXPLORE_DRY_RUNS (2)
├── bin/webpool.js                    ✏️ query add, query import, query list, explore --budget N [--provider p]
└── test/
    ├── frontier.test.js              ✅ priorité, épuisement, repos, ordre des requêtes jamais lancées
    ├── providers.test.js             ✏️ paramètre de page de chaque provider
    └── integration/explore.test.js   ✅ explore sur provider file : rendement enregistré, page avancée, épuisement
```

## User Journey

```mermaid
flowchart TD
  A[webpool query import --file seeds.json] --> B[requêtes actives, jamais lancées]
  B --> C[webpool explore --budget 20]
  C --> D[choisit les 20 plus prioritaires : jamais lancées, puis meilleur rendement]
  D --> E[ingest de la page next_page]
  E --> F[search_query_run : résultats, URLs nouvelles, domaines nouveaux]
  F --> G{page max ou N passages sans URL nouvelle ?}
  G -->|oui| H[exhausted, revient depuis la page 0 après le repos]
  G -->|non| I[next_page + 1, priorité recalculée]
```

## Test Scope

```mermaid
---
title: Test scope
---
journey
  section Setup
    Base migrée, provider file avec un export par page => frontière vide: 5: system
  section Happy path
    query import de 3 requêtes => query list les montre actives et jamais lancées: 5: cli
    explore --budget 2 => deux requêtes lancées page 0, rendement affiché par requête: 5: cli
    explore --budget 2 => la requête jamais lancée passe avant les autres: 5: cli
    explore répété => la requête la plus riche en domaines nouveaux remonte: 5: cli
  section Edge case - épuisement
    page max atteinte ou 2 passages sans URL nouvelle => explore => requête exhausted, plus choisie: 1: cli
  section Edge case - repos écoulé
    exhausted_at plus vieux que le repos => explore => requête relancée depuis la page 0: 1: cli
  section Edge case - doublon
    même provider et même requête => query add => refus sans doublon: 1: cli
  section Teardown
    Tables vidées => base de test propre: 5: system
```

## Tasks to do

### `1)` Schéma et fonctions pures

> La frontière se décide sans base.

1. Migration 003 ; élargir le CHECK de `processing_run.kind` à `explore` ; `UNIQUE (provider, query)` ; `tags TEXT[]` (par exemple `lieu:nagasaki`, `lang:ja`) ; `origin` seed ou generated.
2. `frontier.js` : priorité calculée à la sélection depuis `search_query_run`, jamais stockée = moyenne amortie des domaines nouveaux par passage ; requête jamais lancée = priorité maximale ; page max par provider (Brave : 9) ; épuisement ; repos.

### `2)` Pagination des providers et rendement à l'ingestion

> Chaque provider sait aller à la page n ; l'ingestion compte les domaines nouveaux.

1. Paramètre `page` dans `search()` de chaque provider, défaut 0, comportement actuel inchangé ; le provider file l'ignore.
2. Ingestion : `newDomains` = nombre de lignes insérées dans `domain_profile` par le lot (phase 1) ; exact même entre deux requêtes d'un même run, sans attendre la normalisation.

### `3)` Commandes

> Alimenter, lire et lancer la frontière.

1. `query add --provider p --query q [--tags a,b]`, `query import --file f` (JSON : liste de provider, query, tags), `query list [--status s]`.
2. `explore --budget N` : un run `explore`, une ligne par requête (page, résultats, URLs nouvelles, domaines nouveaux), pause d'une seconde entre deux appels Brave.

## Test acceptance criteria

| Task | Acceptance criteria |
| ---- | ------------------- |
| 1 | Pour un historique de passages donné, la priorité et l'état sont déterministes et testés sans base. |
| 2 | Brave reçoit `offset=n` ; un appel sans page garde le comportement actuel. |
| 2 | Un domaine nouveau compte une seule fois par passage, même présent sur plusieurs résultats. |
| 3 | `explore --budget N` n'appelle jamais un provider plus de N fois. |
| 3 | Une requête épuisée n'est plus choisie avant la fin de son repos. |
