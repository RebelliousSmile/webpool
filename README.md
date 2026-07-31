# webpool

Corpus d'URLs normalisées, enrichies et classées par thèmes, restitué en **pools
matérialisés** selon un besoin précis (un « LoRA manuel » d'URLs). PostgreSQL est
le socle de stockage et de traçabilité.

## Filiation

webpool est l'évolution de [`image-sources-rater`](https://github.com/RebelliousSmile/image-sources-rater)
(archivé) : même idée de catalogue de sources notées par usage, mais le stockage
fichiers JSON devient un schéma PostgreSQL, la discovery ponctuelle devient un
pipeline d'ingestion SERP, et le classement par domaine devient une
classification par URL (taxonomie, facettes, scores).

## Pipeline

```
ingest ──► normalize ──► classify ──► pool
(SERP)     (canonique,    (thèmes,     (sélection
            dédup)         facettes,    matérialisée,
                           scores)      rangée)
```

Chaque étape est tracée dans `processing_run` ; chaque URL garde ses sources
(`url_source` : provider, requête, rang SERP, date de découverte).

## Démarrage

```bash
pnpm install
pnpm db:up                  # PostgreSQL 17 via docker compose (schéma auto-appliqué)
cp .env.example .env        # optionnel : défauts corrects pour le compose local

# Ingestion depuis un export JSON (offline) ou Brave Search (BRAVE_API_KEY)
pnpm webpool ingest --query "forest lora" --provider file --input test/fixtures/serp-sample.json
pnpm webpool ingest --query "forest lora" --provider brave

pnpm webpool normalize            # suit les redirections, canonise, déduplique
pnpm webpool normalize --offline  # sans réseau : canonise l'URL brute

pnpm webpool classify             # taxonomie config/taxonomy.json, règles + scores

# Pools matérialisés
pnpm webpool pool create --slug lora-foret --label "LoRA forêt" --file mes-criteres.json
pnpm webpool pool refresh --slug lora-foret
pnpm webpool pool show --slug lora-foret
pnpm webpool stats
```

Exemple de définition de pool (lisible et réexécutable) :

```json
{
  "theme": "ia-generative",
  "subthemes": ["lora-training"],
  "facets": { "content-type": "tutoriel" },
  "min_quality": 0.5,
  "order": "composite",
  "limit": 50
}
```

## Structure

| Chemin | Rôle |
|---|---|
| `db/init/001_init.sql` | Schéma PostgreSQL (url_item, url_source, theme, url_theme, facet_definition, url_facet_value, pool, pool_item, processing_run) |
| `src/ingest/` | Providers SERP (`file`, `brave`) + insertion tracée |
| `src/normalize/` | Canonisation stricte (tracking, redirections, dédup domaine+canonique) |
| `src/classify/` | Classifieur par règles piloté par `config/taxonomy.json` |
| `src/pools/` | Définition JSON → SQL paramétré → matérialisation rangée |
| `bin/webpool.js` | CLI |
| `test/` | Tests unitaires (vitest) des fonctions pures |

## Tests

```bash
pnpm test
```

Les tests couvrent les fonctions pures (normalisation, classification, critères
de pool). Aucune base n'est requise pour la suite de tests.
