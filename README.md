# webpool

Corpus d'URLs normalisées, enrichies et classées par thèmes, restitué en **pools
matérialisés** selon un besoin précis (un « LoRA manuel » d'URLs). PostgreSQL est
le socle de stockage et de traçabilité.

Présentation et autres applications : <https://www.scriptami.com/applications/>.
Licence [MIT](LICENSE).

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

## Exemple : un pool, de la requête aux URLs classées

Requête d'origine `forest lora` (7 résultats SERP, ici le jeu
[`test/fixtures/serp-sample.json`](test/fixtures/serp-sample.json) via le provider
`file`), puis le pool défini par [`examples/pool-ia-generative.json`](examples/pool-ia-generative.json) :

```bash
pnpm webpool ingest --query "forest lora" --provider file --input test/fixtures/serp-sample.json
# Ingest run : 7 résultats, 7 nouvelles URLs, 0 déjà connues.
pnpm webpool normalize --offline
# Normalize run : 6 normalisées, 1 doublons, 0 erreurs (sur 7).
pnpm webpool classify
# Classify run : 6 classées, dont 0 sans thème.
pnpm webpool pool create --slug lora-foret --label "LoRA forêt" --file examples/pool-ia-generative.json
# Pool "lora-foret" créé et matérialisé : 4 URLs.
pnpm webpool pool export --slug lora-foret --format md
```

Sortie :

| # | Titre | Domaine | Score |
|---|---|---|---|
| 1 | [kohya-ss/sd-scripts: LoRA training scripts](https://github.com/kohya-ss/sd-scripts) | github.com | 0.950 |
| 2 | [Forest LoRA models — Civitai](https://civitai.com/models?query=forest+lora) | civitai.com | 0.900 |
| 3 | [LoRA training guide](https://example.com/lora-training-guide) | example.com | 0.900 |
| 4 | [LoRA training tutorial video](https://youtube.com/watch?v=abc) | youtube.com | 0.850 |

Ce que le pipeline a fait entre les 7 résultats et ces 4 URLs :

- `www.unsplash.com/s/photos/forest?utm_source=…` et `unsplash.com/s/photos/forest`
  sont dédupliquées (tracking retiré, domaine + URL canonique) ; la photographie
  Unsplash est classée `photographie`, donc hors du pool `ia-generative`.
- `europeana.eu` est classée `patrimoine` malgré la requête « forest lora » : le
  contenu propre de l'URL pèse plus que la requête qui l'a découverte.
- Les 4 URLs retenues sont classées `ia-generative` et rangées par score composite
  (pertinence + qualité).

Le même pool en CSV (`--format csv`) :

```csv
rank,url,domain,title,score
1,https://github.com/kohya-ss/sd-scripts,github.com,kohya-ss/sd-scripts: LoRA training scripts,0.950
2,https://civitai.com/models?query=forest+lora,civitai.com,Forest LoRA models — Civitai,0.900
```

## Démarrage

```bash
pnpm install
pnpm db:up                  # PostgreSQL 17 via docker compose (schéma auto-appliqué)
cp .env.example .env        # optionnel : défauts corrects pour le compose local

# Ingestion depuis un export JSON (offline) ou un provider SERP (clés dans .env, voir .env.example)
pnpm webpool ingest --query "forest lora" --provider file --input test/fixtures/serp-sample.json
pnpm webpool ingest --query "forest lora" --provider brave
pnpm webpool ingest --query "forest lora" --provider searxng     # SEARXNG_URL
pnpm webpool ingest --query "forêt" --provider europeana        # EUROPEANA_API_KEY
pnpm webpool ingest --query "forest" --provider flickr          # FLICKR_API_KEY

pnpm webpool normalize            # suit les redirections, canonise, déduplique
pnpm webpool normalize --offline  # sans réseau : canonise l'URL brute

pnpm webpool classify             # taxonomie config/taxonomy.json, règles + scores

# Pools matérialisés
pnpm webpool pool create --slug lora-foret --label "LoRA forêt" --file mes-criteres.json
pnpm webpool pool refresh --slug lora-foret
pnpm webpool pool show --slug lora-foret
pnpm webpool pool export --slug lora-foret --format csv --out lora-foret.csv   # json | csv | md, stdout par défaut
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

### Export et réexécutabilité

`pool export` respecte le rang du pool et fournit URL, domaine, titre et score.
Sur stdout par défaut, il se compose avec d'autres outils
(`webpool pool export --slug x | jq '.items[].url'`). Le format JSON inclut la
définition du pool sous `pool.definition` : pour réexécuter le pool ailleurs,
extraire cette définition dans un fichier et lancer `pool create --file`.
Dans le CSV, les titres commençant par `= + - @` sont préfixés d'une apostrophe
pour ne pas être interprétés comme formules par un tableur.

### Politesse réseau

`normalize` (en ligne) espace les requêtes vers un même hôte, réessaie avec backoff
les erreurs transitoires (timeout, 429, 5xx), ne lit que le `<head>` des pages et
borne la concurrence entre hôtes. Réglages dans `.env` : `WEBPOOL_HOST_DELAY_MS`,
`WEBPOOL_FETCH_RETRIES`, `WEBPOOL_FETCH_BACKOFF_MS`, `WEBPOOL_MAX_BODY_BYTES`,
`WEBPOOL_CONCURRENCY`, `WEBPOOL_FETCH_TIMEOUT_MS`. Une réponse 4xx/5xx place l'URL
en statut `error` (avec son code HTTP) sans interrompre le run.

Les URL visitées viennent de l'extérieur : avant chaque requête, l'hôte est résolu
et refusé (`error` : « hôte refusé ») si une de ses adresses n'est pas publique —
loopback, plages privées, link-local et métadonnées cloud (`169.254.169.254`),
CGNAT, IPv6 locales. Les redirections sont suivies une à une : chaque saut repasse
ce contrôle et le délai par hôte, dans la limite de `WEBPOOL_MAX_REDIRECTS`
(défaut 5, au-delà : « trop de redirections »). `WEBPOOL_ALLOW_PRIVATE_HOSTS=1`
désactive la garde, pour un usage intranet assumé. Les appels aux providers SERP
(dont un SearXNG local) ne sont pas filtrés.

Le `<link rel="canonical">` d'une page n'est retenu que s'il désigne le même
domaine que l'URL finale (hôte exact, `www.` ignoré) ; sinon l'URL finale sert
d'URL canonique, sans fusion avec l'autre site.

### Providers SERP

| Provider | Clé / config | Remarque |
|---|---|---|
| `file` | aucune | export JSON hors-ligne |
| `brave` | `BRAVE_API_KEY` | généraliste |
| `searxng` | `SEARXNG_URL` | méta-moteur auto-hébergé, sans clé ; format JSON à activer |
| `europeana` | `EUROPEANA_API_KEY` | patrimoine culturel |
| `flickr` | `FLICKR_API_KEY` | photographie |

Google Custom Search n'est pas retenu : l'API est fermée aux nouveaux clients et
s'arrête le 1er janvier 2027.

## Structure

| Chemin | Rôle |
|---|---|
| `db/init/001_init.sql` | Schéma PostgreSQL (url_item, url_source, theme, url_theme, facet_definition, url_facet_value, pool, pool_item, processing_run) |
| `src/ingest/` | Providers SERP (`file`, `brave`, `searxng`, `europeana`, `flickr`) + insertion tracée |
| `src/normalize/` | Canonisation stricte (tracking, redirections, dédup domaine+canonique), fetch poli |
| `src/classify/` | Classifieur par règles piloté par `config/taxonomy.json` |
| `src/pools/` | Définition JSON → SQL paramétré → matérialisation rangée → export |
| `bin/webpool.js` | CLI |
| `test/` | Tests unitaires (vitest) des fonctions pures |
| `test/integration/` | Tests des couches DB (PostgreSQL local) |

## Tests

```bash
pnpm test               # fonctions pures, aucune base requise
pnpm db:up
pnpm test:integration   # couches DB (ingest, normalize, classify, pools)
```

La suite d'intégration utilise le PostgreSQL docker local dans un schéma jetable créé
puis supprimé par fichier de test, remis à zéro entre les tests. Elle charge `.env` et
calcule la même URL que le CLI (`DATABASE_URL`, sinon `localhost:${WEBPOOL_DB_PORT:-5432}`).

Sur un poste, elle est ignorée avec un avertissement si la base est injoignable.
`WEBPOOL_IT_REQUIRED=1` la rend obligatoire : une base injoignable fait alors échouer
la commande. La CI GitHub Actions (`.github/workflows/ci.yml`, Node 22 et 24, service
`postgres:17-alpine`) la rend obligatoire d'office et exécute les deux suites à chaque
push et pull request.

## Licence

[MIT](LICENSE). Voir aussi <https://www.scriptami.com/applications/>.
