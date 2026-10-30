---
status: done
---

<!-- Fill or omit these sections; never add, rename, or reorder one. -->

# Instruction: Lien entre chaque domaine nouveau et l'appel qui l'a trouvé

## Architecture projection

> Tree of the final files. ✅ create · ✏️ modify · ❌ delete

```txt
.
├── db/migrations/005_domain_run.sql ✅ domain_profile.first_run_id, search_query_run.ingest_run_id (nullables, index)
├── src/domains/index.js             ✏️ registerDomains(client, domains, firstQuery, runId) remplit first_run_id
├── src/ingest/index.js              ✏️ transmet son runId à registerDomains
├── src/explore/index.js             ✏️ enregistre ingest_run_id dans search_query_run
└── test/integration/explore.test.js ✏️ un appel relie ses domaines nouveaux à son search_query_run
```

## User Journey

```mermaid
flowchart TD
  A[explore lance la requête q] --> B[ingest, run R]
  B --> C[domain_profile : nouveaux domaines avec first_run_id = R]
  C --> D[search_query_run : ingest_run_id = R]
  D --> E[jointure : domaines nouveaux d'un appel donné]
```

## Test Scope

```mermaid
---
title: Test scope
---
journey
  section Setup
    base de test migrée jusqu'à 005, provider factice => base vide: 5: system
  section Happy path
    explore avec une requête renvoyant 3 domaines inconnus => les 3 lignes domain_profile portent l'ingest_run_id du search_query_run: 5: system
  section Edge case - domaine déjà connu
    domaine déjà dans domain_profile => explore => son first_run_id n'est pas modifié: 1: system
  section Edge case - historique
    lignes antérieures à 005 => migrate => first_run_id et ingest_run_id restent NULL, aucune erreur: 1: system
  section Teardown
    tables vidées par helpers.js => base de test vide: 5: system
```

## Tasks to do

### `1)` Migration 005

> Deux colonnes nullables : l'historique reste lisible, seuls les nouveaux appels sont reliés.

1. `ALTER TABLE domain_profile ADD COLUMN first_run_id` et `ALTER TABLE search_query_run ADD COLUMN ingest_run_id`, du type de l'id de la table des runs, avec index.

### `2)` Remplissage

> Le run ingest est l'unité commune aux deux tables.

1. `registerDomains` accepte un `runId` et l'insère ; `normalize` continue de l'appeler sans runId.
2. `ingest` passe son runId ; `explore` lit le `runId` renvoyé par `withRun` et le stocke dans `ingest_run_id`.

## Test acceptance criteria

| Task | Acceptance criteria |
| ---- | ------------------- |
| 1 | `migrate` sur une base en 004 ajoute les deux colonnes sans toucher aux lignes existantes. |
| 2 | Après un `explore`, chaque domaine nouveau d'un appel est retrouvé par jointure `search_query_run.ingest_run_id = domain_profile.first_run_id`. |
| 2 | Les 56 tests d'intégration existants passent. |
