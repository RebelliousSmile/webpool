---
status: pending
---

<!-- Fill or omit these sections; never add, rename, or reorder one. -->

# Instruction: Ordre `rarity` dans les pools

## Architecture projection

> Tree of the final files. ✅ create · ✏️ modify · ❌ delete

```txt
.
├── src/pools/criteria.js            ✏️ ORDERS gagne rarity ; jointure agrégée du nombre d'URLs vivantes par domaine ; SCORE_EXPR rarity = 1 / sqrt(ce nombre) ; recent expose un score lisible
├── README.md                        ✏️ ordre rarity documenté
└── test/
    ├── criteria.test.js             ✏️ validation de order: rarity
    └── integration/pipeline.test.js ✏️ pool rarity : domaine rare avant domaine massif
```

## User Journey

```mermaid
flowchart TD
  A[pool JSON avec order: rarity] --> B[webpool pool create]
  B --> C[score = 1 / sqrt URLs du domaine]
  C --> D[égalité départagée par la qualité puis l'URL]
  D --> E[webpool pool show : sources rares en tête]
```

## Test Scope

```mermaid
---
title: Test scope
---
journey
  section Setup
    Corpus : 10 URLs d'un domaine massif, 1 URL d'un domaine rare => état connu: 5: system
  section Happy path
    pool create avec order rarity => l'URL du domaine rare sort en premier, score 1.000: 5: cli
    pool refresh après ajout d'URLs au domaine rare => son score baisse: 5: cli
  section Edge case - ordre inconnu
    order rareté mal orthographié => pool create => refus listant les ordres valides: 1: cli
  section Edge case - recent
    order recent => pool show => score non nul et cohérent avec la date: 1: cli
  section Teardown
    Tables vidées => base de test propre: 5: system
```

## Tasks to do

### `1)` Ordre `rarity`

> Faire remonter les domaines peu représentés dans le corpus.

1. Ajouter `rarity` à `ORDERS` et à la validation des critères.
2. Expression SQL : une seule jointure `LEFT JOIN (SELECT domain, count(*) … WHERE status <> 'duplicate' GROUP BY domain)`, ajoutée seulement pour cet ordre ; `1 / sqrt(count)` ; départage par qualité puis URL pour un ordre stable.

### `2)` Score de l'ordre `recent`

> Le score affiché vaut toujours 0 aujourd'hui.

1. Exposer un score décroissant avec l'âge (par exemple `1 / (1 + jours depuis first_seen)`), sans changer l'ordre actuel.

## Test acceptance criteria

| Task | Acceptance criteria |
| ---- | ------------------- |
| 1 | Dans un pool `rarity`, une URL d'un domaine à 1 URL précède toute URL d'un domaine à 10 URLs. |
| 1 | Deux exécutions de `pool refresh` sur le même corpus donnent le même ordre. |
| 2 | L'ordre `recent` est inchangé et son score n'est plus constant. |
