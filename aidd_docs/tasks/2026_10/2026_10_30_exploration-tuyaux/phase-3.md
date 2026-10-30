---
status: pending
---

<!-- Fill or omit these sections; never add, rename, or reorder one. -->

# Instruction: Tuyaux : pression, bascule et rotation

## Architecture projection

> Tree of the final files. ✅ create · ✏️ modify · ❌ delete

```txt
.
├── db/migrations/006_explore_pipe.sql ✅ explore_pipe(slug PK, entered_at, is_current) ; la référence se recalcule, elle n'est pas stockée
├── src/explore/pipes.js               ✅ pipeOf(tags), pressure(runs), shouldSwitch(...), nextPipe(...) : fonctions pures
├── src/explore/index.js               ✏️ explore : évalue le tuyau courant, choisit ses requêtes, passe le reste du budget au suivant
├── src/config.js                      ✏️ pipeGoodScore (0,5), pipeWindow (3), pipeDropRatio (0,5), variables WEBPOOL_PIPE_*
├── bin/webpool.js                     ✏️ commande `pipe list` : tuyaux, requêtes actives, pression, référence, tuyau courant
├── test/pipes.test.js                 ✅ pression, bascule, rotation, retour au premier, tuyau defaut
├── test/config.test.js                ✏️ variables WEBPOOL_PIPE_*
└── test/integration/explore.test.js   ✏️ explore suit le tuyau courant et bascule
```

## User Journey

```mermaid
flowchart TD
  A[début de explore] --> B[pression du tuyau courant sur ses 3 derniers appels jugés]
  B --> C{pression ≤ 0,5 × référence ?}
  C -->|non| D[requêtes du tuyau courant, priorité existante]
  C -->|oui| E[tuyau suivant, référence remise à zéro]
  E --> D
  D --> F{plus de requête active dans le tuyau ?}
  F -->|oui| E
  F -->|non, budget épuisé| G[fin du passage]
  E -->|dernier tuyau| H[retour au premier]
```

## Test Scope

```mermaid
---
title: Test scope
---
journey
  section Setup
    requêtes étiquetées flot:a, flot:b et une sans étiquette, provider factice => trois tuyaux a, b, defaut: 5: system
  section Happy path
    premier explore => tous les appels vont aux requêtes de a: 5: system
    appels de a avec 4 domaines bien notés chacun puis 1 => explore suivant => bascule sur b: 5: system
    pipe list => b courant, pression et référence de a affichées: 5: cli
  section Edge case - tuyau vidé en cours de passage
    a n'a plus que 2 requêtes actives, budget 5 => explore => 2 appels à a, 3 à b: 1: system
  section Edge case - rotation complète
    defaut est le dernier tuyau et sa pression baisse => explore => retour à a avec une référence nouvelle: 1: system
  section Edge case - appels pas encore jugés
    deux explore sans classify entre eux => second explore => les appels du premier ne sont pas jugés, pas de bascule: 1: system
  section Edge case - tuyau stérile
    3 premiers appels jugés de a sans domaine bien noté => explore => bascule sur b: 1: system
  section Edge case - aucun tuyau actif
    toutes les requêtes épuisées et non reposées => explore => 0 appel, aucune erreur: 1: system
  section Teardown
    tables vidées par helpers.js => base de test vide: 5: system
```

## Tasks to do

### `1)` Fonctions pures

> Tout le raisonnement se teste sans base.

1. `pipeOf(tags)` : slug de la première étiquette `flot:`, sinon `defaut`.
2. Un appel est jugé quand aucune URL de ses domaines nouveaux n'est en `pending` ni en `normalized` (`error` et `duplicate` comptent comme terminées) ; un domaine sans URL classée n'est pas bien noté. `pressure(judgedRuns)` = domaines bien notés ÷ appels réussis. La référence de la visite est la pression des `window` premiers appels jugés depuis `entered_at` ; la pression courante, celle des `window` derniers ; `null` tant qu'il y a moins de `window` appels jugés, et aucune bascule sur `null`. Bascule quand pression ≤ `dropRatio` × référence : un tuyau dont la référence et la pression sont nulles bascule.
3. `shouldSwitch({ pressure, reference, dropRatio, activeQueries })` et `nextPipe(pipes, current)` dans l'ordre de première apparition, avec retour au premier.

### `2)` État et requêtes

> Une seule ligne `is_current` à la fois ; entrer dans un tuyau met `entered_at` à maintenant, ce qui remet sa référence à zéro.

1. Migration 006 ; `explore` lit les appels du tuyau depuis `entered_at` en joignant `search_query_run`, `domain_profile.first_run_id` et la meilleure note par domaine dans `url_item`.
2. Dans `explore`, après `wakeRested` : évaluer, basculer si besoin, puis `selectQueries` restreint au tuyau ; budget restant au tuyau suivant tant qu'il en reste un avec des requêtes actives, sans revisiter un tuyau dans le même passage.
3. Paramètres dans `src/config.js`, commande `pipe list`.

## Test acceptance criteria

| Task | Acceptance criteria |
| ---- | ------------------- |
| 1 | `test/pipes.test.js` couvre sans base : pression, appel non jugé, `null` sous `window`, bascule au seuil et sous le seuil, référence nulle, rotation et retour au premier, tuyau `defaut`. |
| 2 | `test/integration/explore.test.js` couvre : tuyau vidé en cours de passage, deux explore sans classify, aucun tuyau actif. |
| 2 | Avec trois tuyaux, des `explore` successifs vont à a, puis à b dès que la pression de a passe sous la moitié de sa référence, puis à defaut, puis de nouveau à a. |
| 2 | Un passage ne relance jamais un tuyau déjà quitté dans ce même passage. |
| 3 | `webpool pipe list` affiche chaque tuyau avec son nombre de requêtes actives, sa pression, sa référence et le tuyau courant. |
