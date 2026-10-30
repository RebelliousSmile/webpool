---
status: pending
---

<!-- Fill or omit these sections; never add, rename, or reorder one. -->

# Instruction: Étiquettes `flot:`, documentation et mise en production

## Architecture projection

> Tree of the final files. ✅ create · ✏️ modify · ❌ delete

```txt
.
├── src/explore/index.js                       ✏️ query import ajoute les étiquettes manquantes aux requêtes existantes (aujourd'hui ON CONFLICT DO NOTHING)
├── examples/creatures/queries.json            ✏️ flot:creatures
├── examples/japon/queries.json                ✏️ flot:japon
├── examples/psychologie-2025/queries.json     ✏️ flot:psychologie-2025
├── examples/saint-petersbourg/queries.json    ✏️ flot:saint-petersbourg
├── test/integration/explore.test.js           ✏️ réimport : étiquettes fusionnées, statut et compteurs inchangés
└── README.md                                  ✏️ tuyaux, étiquette flot:, variables WEBPOOL_PIPE_*, pipe list

Serveur (hors dépôt)
└── ~/www/webpool-data/queries/*.json          ✏️ mêmes étiquettes, réimportées
```

## User Journey

```mermaid
flowchart TD
  A[étiquettes flot: dans les exemples] --> B[commit et push sur demande]
  B --> C[deploy:prod ad --check puis --apply après confirmation]
  C --> D[migrate 005 et 006, classify --all pour les notes CJK]
  D --> E[query import des fichiers étiquetés]
  E --> F[pipe list : 4 tuyaux, japon courant]
```

## Test Scope

```mermaid
---
title: Test scope
---
journey
  section Setup
    requête existante sans étiquette flot:, déjà lancée 2 fois => runs 2: 5: system
  section Happy path
    query import du même fichier avec flot:japon => la requête porte flot:japon, runs et statut inchangés: 5: system
    pipe list en production après import => creatures, japon, psychologie-2025, saint-petersbourg listés: 5: cli
  section Edge case - étiquette déjà présente
    réimport identique => query import => aucune étiquette en double: 1: system
  section Edge case - tâche planifiée
    déploiement demandé un lundi vers 4 h => vérifier qu'aucun cycle ne tourne avant --apply: 1: cli
```

## Tasks to do

### `1)` Import et étiquettes

> Les requêtes de production existent déjà : l'import doit pouvoir les étiqueter.

1. `ON CONFLICT (provider, query) DO UPDATE SET tags` = union sans doublon, rien d'autre ; le résumé d'import distingue ajoutées et mises à jour.
2. Ajouter `flot:<exemple>` à chaque requête des quatre fichiers d'exemple.

### `2)` Documentation

> Le README explique comment l'exploration choisit ce qu'elle lance.

1. Section sur les tuyaux : étiquette, pression, bascule, rotation, tuyau `defaut`, `pipe list`, variables `WEBPOOL_PIPE_*`.

### `3)` Production

> Rien ne part sans demande explicite de l'utilisateur.

1. Commit et push sur demande ; `pnpm deploy:prod ad --check`, puis `--apply` après confirmation, hors passage de la tâche #37068.
2. En ssh : `classify --all` (peut changer des thèmes, donc des pools, par la reconnaissance des mots-clés CJK de la phase 1 ; relever `pool list` avant et après), copie des fichiers étiquetés dans `~/www/webpool-data/queries/`, `query import`, `pipe list`.

## Test acceptance criteria

| Task | Acceptance criteria |
| ---- | ------------------- |
| 1 | Réimporter un fichier étiqueté sur une base qui contient déjà ses requêtes ajoute les étiquettes sans changer `runs`, `status` ni `next_page`. |
| 2 | Le README décrit l'étiquette `flot:`, la bascule et les trois variables avec leurs valeurs par défaut. |
| 3 | En production, `pipe list` montre les quatre tuyaux ; le passage planifié suivant appelle d'abord les requêtes du tuyau courant, puis celles du suivant seulement si le courant n'a plus de requête active. |
