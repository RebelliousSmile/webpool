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
pnpm db:up                  # PostgreSQL 17 via docker compose, puis webpool migrate
cp .env.example .env        # optionnel : défauts corrects pour le compose local

# Ingestion depuis un export JSON (offline) ou un provider SERP (clés dans .env, voir .env.example)
pnpm webpool ingest --query "forest lora" --provider file --input test/fixtures/serp-sample.json
pnpm webpool ingest --query "forest lora" --provider brave
pnpm webpool ingest --query "forest lora" --provider searxng     # SEARXNG_URL
pnpm webpool ingest --query "forêt" --provider europeana        # EUROPEANA_API_KEY
pnpm webpool ingest --query "forest" --provider flickr          # FLICKR_API_KEY
pnpm webpool ingest --query "forest lora" --provider openrouter  # OPENROUTER_API_KEY

pnpm webpool normalize            # suit les redirections, canonise, déduplique
pnpm webpool normalize --offline  # sans réseau : canonise l'URL brute

pnpm webpool classify             # taxonomie config/taxonomy.json, règles + scores
pnpm webpool classify --all       # reclasse tout le corpus, par lots de --limit (défaut 100)

# Pools matérialisés
pnpm webpool pool create --slug lora-foret --label "LoRA forêt" --file mes-criteres.json
pnpm webpool pool create --slug lora-foret --file mes-criteres.json --force   # remplace un pool existant
pnpm webpool pool refresh --slug lora-foret
pnpm webpool pool show --slug lora-foret
pnpm webpool pool export --slug lora-foret --format csv --out lora-foret.csv   # json | csv | md | txt, stdout par défaut
pnpm webpool stats
pnpm webpool migrate              # applique les migrations manquantes (pnpm db:up le fait)
```

Sans `--force`, `pool create` refuse un slug déjà pris et laisse sa définition
intacte. Chaque critère est typé à la lecture du fichier : un critère inconnu ou mal
typé (`limit` non entier, `subthemes` qui n'est pas un tableau…) est refusé avec un
message qui le nomme. Dans l'export Markdown, le HTML des titres est échappé.

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

Ordres (`order`) et score affiché par `pool show` :

| Ordre | Rang | Score |
| ----- | ---- | ----- |
| `composite` (défaut) | moyenne pertinence et qualité, décroissante | cette moyenne |
| `quality` | qualité décroissante | la qualité |
| `relevance` | pertinence décroissante | la pertinence |
| `recent` | découverte la plus récente d'abord | `1 / (1 + jours depuis la découverte)` |
| `rarity` | domaines les moins représentés d'abord, puis qualité | `1 / sqrt(URLs du domaine)`, doublons exclus : 1 pour un domaine à une seule URL |

À rang égal, l'id de l'URL départage : deux `pool refresh` sur le même corpus donnent
le même ordre.

### Schéma et migrations

Le schéma vit dans `db/migrations/NNN_description.sql`. `webpool migrate` applique
dans l'ordre les fichiers absents de la table `schema_migration`, chacun dans sa
transaction avec l'enregistrement de sa version : une migration en erreur n'est ni
appliquée ni enregistrée, et le message nomme le fichier. Un verrou consultatif
empêche deux `migrate` concurrents de se chevaucher. Une base créée avant les
migrations (tables présentes, pas de `schema_migration`) enregistre `001` comme
baseline sans la rejouer et garde son corpus.

Règle : une migration par changement de schéma, et jamais de modification d'une
migration publiée (une base l'a peut-être déjà appliquée) ; une correction est une
nouvelle migration.

### Taxonomie

`config/taxonomy.json` est la source de vérité : à chaque `classify`, thèmes et
facettes sont synchronisés en base dans une transaction. Un thème ou une facette
retiré du JSON est supprimé, avec ses affectations ; un slug en double (thème,
sous-thème ou facette) fait échouer le run sans rien écrire. Après une
modification, `classify --all` reclasse le corpus existant.

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

Les URL sont traitées par blocs de `WEBPOOL_NORMALIZE_CHUNK` (défaut 100) : réseau
du bloc, puis écriture, puis bloc suivant. La mémoire reste bornée et un bloc écrit
est conservé si un bloc suivant échoue. L'ingest, la classification et le refresh
d'un pool écrivent chacun leur lot en quelques requêtes groupées.

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
| `openrouter` | `OPENROUTER_API_KEY` | plugin web d'OpenRouter ; repli sur `brave` dans `explore` |

Le provider `openrouter` lit les URLs dans les annotations `url_citation` du
plugin `web`, qui rendent tous les résultats de recherche : la réponse du modèle
n'est jamais lue. `OPENROUTER_ENGINE` choisit le moteur (`perplexity` par défaut,
`exa`, `parallel`), `OPENROUTER_MODEL` le modèle (`openai/gpt-4.1-nano` par
défaut, 5 tokens de sortie au plus) et `OPENROUTER_TIMEOUT_MS` le délai d'appel
(60 s par défaut). Sur 5 requêtes de test, Perplexity coûtait environ 0,0055 $
l'appel de 20 résultats, Exa 0,0175 $ et Parallel 0,016 $, et 70 à 75 % des
domaines trouvés étaient absents des résultats de Brave. Ce provider ne pagine
pas : une requête s'épuise au premier passage, puis revient après le repos.

Google Custom Search n'est pas retenu : l'API est fermée aux nouveaux clients et
s'arrête le 1er janvier 2027.

## Exploration : des sources de plus en plus rares

`ingest` lance une requête une fois. La boucle d'exploration relance des
requêtes enregistrées, page après page. Elle classe ces requêtes selon les
nouveaux domaines qu'elles ont fait découvrir, abandonne celles qui sont épuisées
et écarte des requêtes Brave les domaines déjà bien représentés. Au fil des
passages, le corpus s'ouvre ainsi à des sources rares. Cela vaut pour toute
ressource : le droit d'usage commercial n'est qu'une facette parmi d'autres.

```bash
# Frontière de requêtes (table search_query)
pnpm webpool query add --provider brave --query "長崎 写真 フリー素材" --tags lieu:nagasaki,lang:ja
pnpm webpool query import --file examples/japon/queries.json   # tableau ou {queries: []}, validé en entier ; étiquette les requêtes connues
pnpm webpool query list [--status active|exhausted|paused]     # page suivante, passages, domaines nouveaux, priorité
pnpm webpool pipe list                                         # tuyaux : requêtes actives, pression, référence, tuyau courant (*)

# Un passage : au plus N appels aux providers, une page par requête choisie
pnpm webpool explore --budget 20 [--provider brave] [--limit 20]

# Le cycle complet, pour une tâche planifiée
pnpm webpool cycle --budget 20 [--provider brave] [--offline]

# Registre des domaines (table domain_profile)
pnpm webpool domain list [--to-qualify] [--limit N]            # URLs par domaine, usage, première requête, [exclu]
pnpm webpool domain set --domain photo-ac.com --usage libre [--note "…"]
pnpm webpool domain exclude --domain pinterest.com             # toujours écarté des requêtes Brave
pnpm webpool domain include --domain pinterest.com             # réintégré (reste écarté s'il est saturé)
```

**Frontière.** Une requête jamais lancée passe en premier. Les autres sont
classées par domaines nouveaux par passage, selon la formule
`domaines / (passages + 1)`. À priorité égale, la requête lancée le moins
récemment passe d'abord. Chaque passage réussi avance la requête d'une page :
Brave reçoit `offset`, SearXNG `pageno`, Flickr `page` et Europeana `start`. Une
requête est épuisée après la page 9, ou après `WEBPOOL_EXPLORE_DRY_RUNS`
passages consécutifs sans URL nouvelle. Elle revient alors, depuis la page 0,
après `WEBPOOL_EXPLORE_REST_DAYS` jours. Une erreur de provider est notée sur la
requête (`search_query_run.error`) sans faire avancer la page ni arrêter le
run. Une requête `openrouter` dont l'appel échoue (réseau, crédit épuisé, clé
absente…) est relancée sur Brave, page 0 : le passage compte, les URLs sont
tracées sous `brave`, mais la requête garde sa page et son état. La sortie
d'`explore` l'indique par `openrouter→brave (repli : …)`. Pour le provider `file`, la requête est le chemin de l'export, et `{page}`
y est remplacé par le numéro de page.

**Tuyaux.** Un tuyau est un sujet : les requêtes étiquetées `flot:<slug>` en
forment un, celles sans étiquette `flot:` forment le tuyau `defaut`. `explore`
ne lance que les requêtes du tuyau courant, dans l'ordre de la frontière. Sa
pression est le nombre de domaines nouveaux bien notés par appel réussi. Un
domaine est bien noté quand sa meilleure URL classée atteint
`WEBPOOL_PIPE_GOOD_SCORE` en moyenne de `relevance` et `quality`. Seuls comptent
les appels jugés : plus aucune de leurs URLs n'attend `normalize` ou `classify`.
La référence est la pression des `WEBPOOL_PIPE_WINDOW` premiers appels jugés
depuis l'entrée dans le tuyau, la pression courante celle des
`WEBPOOL_PIPE_WINDOW` derniers. Au début de chaque `explore`, le tuyau est
quitté si sa pression tombe à `WEBPOOL_PIPE_DROP_RATIO` × sa référence ou en
dessous (un tuyau stérile, à 0 pour 0, est donc quitté), ou s'il n'a plus de
requête active. Le tuyau suivant est pris dans l'ordre de première apparition
des étiquettes, avec retour au premier après le dernier ; y entrer remet sa
référence à zéro. Quand le tuyau courant n'a plus de requête active en cours de
passage, le reste du budget va au suivant, sans revenir à un tuyau quitté dans
ce passage. Une requête OpenRouter s'épuise en un appel : tant que les requêtes
ne sont pas reposées, c'est l'épuisement qui fait passer d'un tuyau à l'autre.
`query import` ajoute aux requêtes déjà connues les étiquettes qui leur
manquent, sans changer leur état. Il suffit donc de réimporter un fichier pour
ranger ses requêtes dans un tuyau.

**Exclusion des domaines saturés.** Avant chaque appel à Brave, la requête reçoit
un suffixe `-site:` par domaine saturé : un domaine qui compte plus de
`WEBPOOL_EXPLORE_SATURATION` URLs normalisées ou classées, ou qui a été exclu
avec `domain exclude`. Les domaines les plus gros passent en premier. Le suffixe
s'arrête dès que la requête dépasserait `WEBPOOL_EXPLORE_QUERY_MAX_CHARS`
caractères. Un domaine visé par un `site:` de la requête n'est jamais exclu. Si
l'ensemble exclu change, la requête repart de la page 0. OpenRouter reçoit les mêmes
domaines, au plus 50, dans le paramètre `exclude_domains`, sans toucher à la
requête.

**Registre et facette `usage-commercial`.** Chaque domaine découvert entre dans
le registre, avec la date et la requête de sa découverte. Il y reste « à
qualifier » tant que `domain set` ne lui a pas donné d'usage : `libre`,
`sous-conditions`, `payant` ou `non-commercial`. La qualification réécrit la
facette des URLs déjà classées, sans reclasser. À la classification, elle
l'emporte sur les motifs de la taxonomie. Faute de qualification, la facette
vaut `a-qualifier`, sauf si un motif de la taxonomie s'applique.

**Cycle.** `cycle` enchaîne `explore`, puis `normalize` et `classify` par lots
de 100 jusqu'à vider la file, puis `pool refresh` de chaque pool. Il affiche
une ligne par étape : appels et requêtes en échec, URLs et domaines nouveaux,
domaines à qualifier, taille de chaque pool. Une étape en échec n'empêche pas
les suivantes. Le code de sortie vaut 1 si une étape échoue entièrement :
exception, échec de chaque appel aux providers, ou échec de chaque pool.

Exemple : le jeu [`examples/japon/`](examples/japon/) contient 24 requêtes
(japonais, anglais, français ; tags `flot:japon`, `lieu:*` et `lang:*`) et des pools par lieu
en ordre `rarity`, dont `nagasaki-libre` (`usage-commercial` = `libre`) :

```bash
pnpm webpool query import --file examples/japon/queries.json
pnpm webpool classify                                          # synchronise les facettes lieu et usage-commercial
pnpm webpool pool create --slug nagasaki --file examples/japon/pools/nagasaki.json
pnpm webpool pool create --slug nagasaki-libre --file examples/japon/pools/nagasaki-libre.json
pnpm webpool cycle --budget 20
pnpm webpool domain list --to-qualify
```

| Variable | Défaut | Rôle |
| -------- | ------ | ---- |
| `WEBPOOL_EXPLORE_REST_DAYS` | 30 | jours de repos d'une requête épuisée |
| `WEBPOOL_EXPLORE_DRY_RUNS` | 2 | passages consécutifs sans URL nouvelle avant épuisement |
| `WEBPOOL_EXPLORE_SATURATION` | 50 | URLs au-delà desquelles un domaine est écarté des requêtes Brave |
| `WEBPOOL_EXPLORE_QUERY_MAX_CHARS` | 400 | longueur maximale d'une requête envoyée, suffixe `-site:` compris |
| `WEBPOOL_PIPE_GOOD_SCORE` | 0.5 | moyenne `relevance`/`quality` de la meilleure URL classée d'un domaine bien noté (entre 0 et 1) |
| `WEBPOOL_PIPE_WINDOW` | 3 | appels jugés de la référence et de la pression courante |
| `WEBPOOL_PIPE_DROP_RATIO` | 0.5 | fraction de la référence à laquelle ou sous laquelle le tuyau est quitté (entre 0 et 1) |

Limites :

- Chaque requête choisie consomme un appel au quota de l'API Brave Search.
  `--budget` borne ce nombre d'appels par passage.
- L'opérateur `-site:` n'a été vérifié que sur Brave, où il est respecté même
  avec 18 exclusions dans une requête de 378 caractères. SearXNG dépend de ses
  moteurs et ne reçoit donc aucune exclusion. Europeana et Flickr non plus.
- Les requêtes s'écrivent à la main. Les générer à partir du corpus est prévu
  dans une phase ultérieure.

## Recherches payantes : dons et giri

Les pools restent gratuits. Une **recherche** (requête envoyée à un provider,
page par page) consomme des tokens : elle se paie d'avance en **giri**, l'unité
entière du grand livre (1 € = `WEBPOOL_GIRI_PER_EUR` giri, 1 000 par défaut).

- Un particulier crédite son portefeuille personnel par un **don**.
- Dans une **communauté**, on ne paie pas pour soi : les membres versent des giri
  au **pot commun** (apport à leur nom), et les recherches sur les pools de la
  communauté se paient sur ce pot, jamais sur un portefeuille personnel. Les
  membres voient ces pools sans accord individuel ; les propriétaires gèrent les
  membres et leurs plafonds depuis l'API (datapool).
- Un **pool public** (`pool publish`) est visible et exportable par tout client,
  sans accord : c'est l'accès gratuit par défaut. Un accès reste un jeton créé par
  l'admin (`client add`) ; il n'y a pas d'inscription en libre-service.

```bash
# Communauté, membres (plafond en giri sur 30 jours glissants), pools rattachés
pnpm webpool community add --slug atelier --label "Atelier photo"
pnpm webpool community join --slug atelier --name alice --role owner
pnpm webpool community join --slug atelier --name bob --monthly 2000
pnpm webpool community attach --slug atelier --pool nagasaki

# Paiement reçu (Liberapay, Ko-fi, virement…) : don ou achat, crédité une seule fois par référence
pnpm webpool pool publish --slug nagasaki        # visible par tout client (unpublish pour revenir)
pnpm webpool wallet credit --name carol --eur 5 --ref liberapay:1234   # 2 € au moins, sinon --force
pnpm webpool wallet credit --community atelier --by bob --eur 20 --ref virement:2026-10-31   # apport de bob au pot
pnpm webpool wallet adjust --community atelier --giri=-500 --note "geste commercial annulé"
pnpm webpool wallet show --community atelier

pnpm webpool pricing                      # prix d'un appel par provider
pnpm webpool requests run [--offline]     # tâche planifiée : exécute les recherches payées
pnpm webpool requests list [--status queued]
pnpm webpool requests cancel --id 12      # recherche en attente, remboursée
pnpm webpool billing report --days 30     # recettes, coût des providers, marge, encours
```

**Prix.** Un appel coûte `max(1, ⌈coût USD × WEBPOOL_USD_EUR × WEBPOOL_PRICE_MARKUP × WEBPOOL_GIRI_PER_EUR⌉)`
giri. Le coût par défaut est celui mesuré pour OpenRouter, selon le moteur
(perplexity 0,0055 $, exa 0,0175 $, parallel 0,016 $), et le tarif public de
Brave (0,005 $). Avec les défauts, un appel OpenRouter coûte 11 giri (0,011 €) et
un appel Brave 10 giri. Les providers gratuits paient le plancher de 1 giri : ils
consomment des quotas et le traitement du serveur. Le provider `file`, qui lit un
fichier local, n'est jamais ouvert aux recherches. Le prix est figé sur la
recherche à l'achat.

**Achat** (`POST /api/v1/requests`, écran « Recherches » de datapool). Une
recherche achète de 1 à `WEBPOOL_REQUEST_MAX_PAGES` pages (1 seule pour
OpenRouter, qui ne pagine pas). Le prix est débité dans la transaction qui
l'inscrit : solde insuffisant (402), plafond du membre atteint (402) ou trop de
recherches en attente (429, `WEBPOOL_REQUEST_MAX_QUEUED`), et rien n'est écrit.
Une recherche sur un pool d'une des communautés du client est payée par cette
communauté, sans choix : `community` est déduite, ou exigée si plusieurs de ses
communautés possèdent le pool. Le pot d'une communauté ne paie que ses pools. Son auteur peut l'annuler tant qu'elle attend, et il est alors
remboursé.

**Exécution.** `requests run` (toutes les 15 minutes) tient le verrou consultatif
du pipeline, partagé avec `cycle` : elle passe son tour pendant un cycle, et le
cycle attend qu'elle finisse, pour qu'ils ne normalisent jamais la même file
ensemble. Elle lance les recherches en attente dans l'ordre d'achat, page après page, avec
l'exclusion des domaines saturés de l'exploration. Elle s'arrête au premier
appel en échec ou à la première page vide ; les pages non lancées sont
remboursées, sans repli vers un autre provider. Une recherche restée en cours
plus d'une heure (processus interrompu) est close et remboursée de ses appels
non faits. Viennent ensuite `normalize`, `classify` et `media`, puis le refresh
des pools visés ; `in_pool` compte les URLs de la recherche présentes dans le
pool. Le coût réel d'un appel OpenRouter (`usage.cost`) est enregistré, une
estimation sinon : `billing report` compare recettes et coût.

**Pools ouverts aux recherches.** Un pool est défini par des critères : une URL
trouvée par une recherche n'y entre que si elle les remplit. Avec
`"include_requests": true` dans sa définition, les URLs classées des recherches
qui visent ce pool **et sont payées par une communauté propriétaire du pool** y
entrent aussi, sans remplir les critères de sujet (`theme`,
`subthemes`, `facets`, `domains_include`). Les seuils `min_relevance` et
`min_quality` et `domains_exclude` s'appliquent toujours.
L'option est désactivée par défaut. Une recherche payée sur un portefeuille
personnel n'entre jamais par cette voie, même sur un pool public : sinon
n'importe quel client qui voit le pool y injecterait des liens pour 1 giri.

**Cadre.** Le « don » donne droit à un service : c'est un prépaiement, sans reçu
fiscal, éventuellement soumis à la TVA selon le statut de l'éditeur. Le giri
reste en circuit fermé : il ne se transfère pas, ne se rembourse pas en € et ne
s'utilise qu'en recherches. Il n'expire pas : les giri non dépensés sont une dette
en recherches, que `billing report` affiche comme encours. Sous
`WEBPOOL_MIN_CREDIT_CENTS` (2 €), les frais fixes d'un paiement (environ 0,25 €)
dépassent la marge : `wallet credit` refuse, sauf `--force`. Le grand livre est
conservé : un client ou une communauté qui a un portefeuille ne se supprime pas en
base (on révoque le client). Le paiement en ligne n'est pas intégré. L'admin
crédite à réception du paiement ; `WEBPOOL_FUNDING_URL` donne à l'interface le
lien de la page de don ou d'achat. Plan, pistes écartées et remise en question :
[`aidd_docs/tasks/2026_10/2026_10_31_recherches-payantes/plan.md`](aidd_docs/tasks/2026_10/2026_10_31_recherches-payantes/plan.md).

| Variable | Défaut | Rôle |
|---|---|---|
| `WEBPOOL_GIRI_PER_EUR` | 1000 | giri crédités pour 1 € |
| `WEBPOOL_USD_EUR` | 0.92 | cours appliqué au coût des providers |
| `WEBPOOL_PRICE_MARKUP` | 2 | majoration du coût (≥ 1) : frais de paiement, appels sans résultat, cours |
| `WEBPOOL_CALL_COST_USD` | aucun | coûts par appel qui remplacent ceux du code : `brave=0.004,openrouter:exa=0.02` |
| `WEBPOOL_REQUEST_PROVIDERS` | `openrouter,brave` | providers ouverts aux recherches (`file` toujours exclu) |
| `WEBPOOL_REQUEST_MAX_PAGES` | 3 | pages achetables par recherche |
| `WEBPOOL_REQUEST_MAX_QUEUED` | 5 | recherches en attente au plus par client |
| `WEBPOOL_MIN_CREDIT_CENTS` | 200 | crédit minimal en centimes (`--force` pour passer outre) |
| `WEBPOOL_FUNDING_URL` | aucune | page de don ou d'achat de giri affichée par datapool |

## Médias des liens

La normalisation en ligne lit le `<head>` de chaque page : description
(`og:description`, sinon `description`), image d'aperçu (`og:image`,
`twitter:image`), type (`og:type`), nom du site, langue et icône du site. Elle fixe
aussi le **type de média** du lien (page, image, vidéo, PDF, données, code, modèle)
d'après le Content-Type, `og:type` et l'URL. Les providers fournissent une
vignette de repli (Flickr `url_w`, Europeana `edmPreview`, Brave `thumbnail`).

```bash
pnpm webpool media                 # vignettes et favicons en attente → cache
pnpm webpool media --retry-failed  # retente les échecs
```

`webpool media` (aussi étape de `cycle`, sautée hors ligne) télécharge ces images
avec les protections de la normalisation (hôtes publics seulement, délai par hôte,
retries, taille bornée), refuse SVG et images de plus de 40 Mpx, réduit en WebP
(vignette 480 px de large, favicon 64 px, métadonnées retirées) et range chaque
fichier sous son empreinte dans `WEBPOOL_MEDIA_DIR`. Un `.ico` n'est accepté que
s'il contient une image PNG. L'API sert ces fichiers sans jeton
(`/api/v1/media/{empreinte}.webp`, cache immuable) : une balise `<img>` ne peut pas
envoyer de jeton, et la route ne lit que le cache, elle ne télécharge jamais rien.

| Variable | Défaut | Rôle |
|---|---|---|
| `WEBPOOL_MEDIA_DIR` | `var/media` du dépôt | cache des vignettes et favicons |
| `WEBPOOL_MEDIA_MAX_BYTES` | 5 Mo | taille maximale d'une image téléchargée |
| `WEBPOOL_MEDIA_CONCURRENCY` | 4 | téléchargements simultanés |

La famille de source (recherche, archives et musées, banques d'images,
communautés, plateformes vidéo, presse et guides, autres) se calcule à la lecture
depuis le domaine (`src/media/kinds.js`) : enrichir la liste ne demande aucune
reprise du corpus.

## API HTTP

`webpool serve` expose le corpus et les pools en JSON, pour l'interface
[datapool](https://github.com/RebelliousSmile/datapool) ou pour des clients. Le
contrat complet est dans [`openapi.json`](openapi.json), servi aussi à
`/api/v1/openapi.json`.

```bash
pnpm webpool client add --name moi --scope admin
# Client "moi" (admin) créé. Jeton, affiché une seule fois :
# wp_…
pnpm webpool serve --port 3000
curl -H "Authorization: Bearer wp_…" http://127.0.0.1:3000/api/v1/admin/stats
```

**Clients.** Chaque client a sa clé ; la base n'en garde que l'empreinte SHA-256
(`api_client`). Un client `admin` voit tout. Un client `read` ne voit que les pools
publics, ceux qui lui sont accordés et ceux de ses communautés, sans leur
définition ni leurs scores ; un autre pool répond 404.

```bash
pnpm webpool client add --name client-a            # scope read par défaut
pnpm webpool client grant --name client-a --slug lora-foret
pnpm webpool client list
pnpm webpool client revoke --name client-a
```

| Route (`/api/v1`) | Accès | Contenu |
|---|---|---|
| `/health`, `/openapi.json` | public | état de la base, contrat |
| `/media/{empreinte}.webp` | public | vignette ou favicon du cache (`Cache-Control: immutable`) |
| `/me` | read | client authentifié |
| `/pools`, `/pools/{slug}` | read | pools visibles ; volumes, domaines principaux, répartition de l'usage commercial |
| `/pools/{slug}/export?format=json\|csv\|md\|txt` | read | le pool entier dans l'ordre de rang, sans définition ni score (`txt` : une URL par ligne) |
| `/pools/{slug}/items` | read | URLs rangées, paginées (`limit` ≤ 500, `offset`), avec description, type de média, famille de source, vignette et favicon |
| `/billing` | read | prix des recherches, solde personnel, communautés (rôle, solde, plafond, dépense sur 30 jours) |
| `/billing/entries?community=` | read | grand livre personnel, ou de la communauté pour ses propriétaires |
| `GET /requests?community=&status=` | read | recherches du client, ou de la communauté pour ses propriétaires |
| `POST /requests` | read | achète une recherche (`{query, provider, pages, pool, community}`), 201 |
| `DELETE /requests/{id}` | read | annule une recherche en attente, remboursée |
| `GET /communities/{slug}/members`, `PUT`/`DELETE …/members/{name}` | read (propriétaires) | membres, rôle, plafond et dépense ; ajout, changement de rôle ou de plafond, retrait ; la communauté garde un propriétaire actif |
| `/admin/stats` | admin | volumes pour un tableau de bord |
| `/admin/pools/{slug}/export?format=json\|csv\|md\|txt` | admin | export de `pool export`, définition et scores compris |
| `/admin/urls`, `/admin/urls/{id}` | admin | corpus filtré (`status`, `theme`, `facet=slug:valeur`, `domain`, `q`, `order`) ; fiche : sources, thèmes, facettes, pools |
| `/admin/themes`, `/admin/facets` | admin | taxonomie en arbre, valeurs de facettes, avec volumes |
| `/admin/domains` | admin | registre (`to_qualify`, `excluded`, `usage`, `q`) |
| `/admin/queries`, `/admin/runs` | admin | frontière d'exploration, historique du pipeline |
| `/admin/requests` | admin | toutes les recherches payantes |

Les erreurs sont en JSON (`{"error": {"code", "message"}}`) : 400 paramètre
invalide, 401 jeton absent ou révoqué, 402 giri insuffisants, 403 route admin,
404, 405, 413 corps de plus de 8 Ko, 415 corps autre que JSON, 429 trop de
recherches en attente. Une erreur
interne répond 500 sans détail ; le détail part dans le journal du serveur, qui
trace une ligne par requête (méthode, chemin, statut, durée, client).

| Variable | Défaut | Rôle |
|---|---|---|
| `WEBPOOL_API_PORT` | `PORT`, sinon 3000 | port d'écoute (`--port`) |
| `WEBPOOL_API_HOST` | `IP`, sinon 127.0.0.1 | adresse d'écoute (`--host`) |
| `WEBPOOL_API_CORS_ORIGINS` | aucune | origines autorisées, séparées par des virgules (ex. l'URL de datapool) |

L'API lit le corpus et n'écrit que les recherches payantes et les membres des
communautés. Pour aller plus loin,
la base peut être ouverte au serveur par un rôle PostgreSQL limité à `SELECT`, plus
`INSERT, UPDATE` sur `search_request`, `wallet` et `wallet_entry`, `INSERT, UPDATE, DELETE` sur
`community_member` (gestion des membres par les propriétaires) et `USAGE` sur
leurs séquences. Elle se déploie comme un site Node.js
(voir *Déploiement*) ; `/api/v1/health` renvoie la version et le commit livré.

## Déploiement (alwaysdata)

Le déployer, c'est installer le CLI sur le compte, le brancher sur une base
PostgreSQL du compte, planifier ses commandes et, pour l'API, faire tourner
`webpool serve` dans un site Node.js.

**Base.** Dans l'admin, *Bases de données > PostgreSQL* : créer une base en
PostgreSQL 17 (version du compose et de la CI) et un utilisateur avec l'accès
complet. Le schéma n'utilise aucune extension. Se connecter sur le port 5432 et non
sur le pgBouncer (5433) : `migrate` prend un verrou consultatif de session, qu'un
pooler peut porter sur une autre session que celle qui le relâche.

**Node.** Fixer Node 24 (ou 22) dans *Environnement > Node.js* pour les tâches
planifiées ; le script de déploiement force `NODEJS_VERSION` (champ `nodeVersion`).

**Préparation, une fois :**

```bash
# sur la cible : le .env de production, à côté du code (pas dedans : la bascule le purgerait)
#   ~/www/webpool.env (chmod 600) : DATABASE_URL=postgres://<user>:<mdp>@postgresql-<compte>.alwaysdata.net:5432/<base>
#                               + clés des providers utilisés
# en local : la cible (fichier ignoré par git) et une clé SSH dédiée côté WSL
cp deploy/targets.example.json deploy/targets.json      # host, user, sshKey…
wsl ssh-keygen -t ed25519 -N "" -C webpool-ad -f ~/.ssh/webpool_ci
wsl ssh-copy-id -i ~/.ssh/webpool_ci.pub <compte>@ssh-<compte>.alwaysdata.net
```

**Déployer** depuis Windows (WSL avec `rsync`, `ssh` et pnpm dans `~/.local/bin`) :

```bash
pnpm deploy:prod ad --check     # archive du commit + install prod en staging WSL, sans contacter la cible
pnpm deploy:prod ad             # prévisualisation : garde, Node, pg_dump, fichiers modifiés
pnpm deploy:prod ad --apply     # livraison
```

Seul le commit `HEAD` de `main` part (`git archive`), jamais la copie de travail.
`--apply`, sous verrou (`~/deploy/webpool-ad/lock`) et garde de cycle de vie :
synchronise dans `~/www/webpool.new` (droits 755/644 vérifiés), y pose un `.htaccess`
`Require all denied`, y lie `.env` vers
`~/www/webpool.env`, sauvegarde la base (`pg_dump -Fc`, 5 dernières gardées dans
`~/deploy/webpool-ad/backups/`), lance `migrate` puis `stats`, et bascule
`~/www/webpool.new` → `~/www/webpool`. La version précédente reste dans `~/www/webpool.old`
jusqu'au déploiement suivant ; les commandes de restauration sont affichées en fin
de run. Une étape en échec arrête tout avant la bascule.

**Données.** Les requêtes et pools d'exemple ne partent pas avec le code : ils
sont copiés une fois dans `~/www/webpool-data/<exemple>/` (`queries.json`,
`pools/*.json`), puis importés sur la cible par `query import` et `pool create`.
Ce répertoire est hors de `~/www/webpool`, donc la bascule ne le touche pas ; la
base reste la seule source de vérité.

**Cache de médias.** `WEBPOOL_MEDIA_DIR=/home/<compte>/www/webpool-data/media`
dans `~/www/webpool.env`, en chemin absolu (`process.loadEnvFile` ne développe pas
`$HOME`) : hors du dossier remplacé, le cache survit aux déploiements. Le script
crée le dossier (champ `mediaDir` de la cible) et refuse de livrer si la variable
n'y pointe pas. Compter environ 25 Ko par vignette (250 Mo pour 10 000 liens) dans
le quota du compte. `sharp` s'installe avec ses binaires linux-x64 lors du
`pnpm install --prod` du staging.

**API (site Node.js).** Une fois, dans l'admin, *Web > Sites > Ajouter un site* :

| Champ | Valeur |
|---|---|
| Type | Node.js |
| Adresse | `api.<domaine>` (certificat Let's Encrypt automatique) |
| Commande | `node $HOME/www/webpool/bin/webpool.js serve` |
| Répertoire de travail | `www/webpool` |
| Environnement | `NODEJS_VERSION=24` |

Le serveur écoute sur `IP` et `PORT` fournis par alwaysdata (lus par
`config.js`) et lit `.env`, lié vers `~/www/webpool.env`, où ajouter
`WEBPOOL_API_CORS_ORIGINS=https://datapool.<domaine>` (sans `/` final). Dans la
cible locale, `apiUrl` (`https://api.<domaine>/api/v1`) et, pour un redémarrage
automatique, `apiSiteId` (identifiant numérique du site, visible dans l'URL de sa
page d'admin).

Après la bascule, le site doit être **redémarré** : il sert sinon l'ancien code
depuis `~/www/webpool.old`. Avec `apiSiteId` et un jeton exporté dans le shell
local (*Profil > Jetons d'API*, jamais versionné ni copié sur la cible) :

```bash
ALWAYSDATA_API_TOKEN=… pnpm deploy:prod ad --apply   # POST /v1/site/<apiSiteId>/restart/
```

Sans jeton, le script affiche la consigne : redémarrer le site dans l'admin. Dans
les deux cas, il attend jusqu'à 3 minutes que `<apiUrl>/health` annonce le commit
livré (fichier `REVISION`), et sort en code 1 sinon. Un retour arrière du code se
termine aussi par un redémarrage du site.

**Première mise en production de l'API**, dans l'ordre :

1. créer le site Node.js ci-dessus et compléter `~/www/webpool.env`
   (`WEBPOOL_MEDIA_DIR`, `WEBPOOL_API_CORS_ORIGINS`) ;
2. `pnpm deploy:prod ad` (prévisualisation), puis `--apply` : migrations jusqu'à
   `010`, bascule, redémarrage, contrôle de `/health` ;
3. sur la cible, créer la clé d'accès :
   `cd ~/www/webpool && NODEJS_VERSION=24 node bin/webpool.js client add --name <nom> --scope admin`
   (le jeton n'est affiché qu'une fois) ;
4. `NODEJS_VERSION=24 node bin/webpool.js media` pour remplir le cache du corpus
   déjà normalisé (les pages normalisées avant la phase 3 n'ont pas d'aperçu : les
   rejouer avec `normalize` après les avoir remises en attente, si besoin) ;
5. déployer datapool (`pnpm deploy:prod ad --apply` dans datapool), qui vérifie
   que son origine figure dans `WEBPOOL_API_CORS_ORIGINS`.

**Tâches planifiées** (*Avancé > Tâches planifiées*, syntaxe cron). Le CLI lit
`.env` à la racine du dépôt quel que soit le répertoire courant, et sort en code 1
sur erreur, ce qui déclenche le mail d'erreur d'alwaysdata. La tâche en place est
créée dans l'admin, pas par le script de déploiement :

| Champ | Valeur |
|---|---|
| Commande | `node bin/webpool.js cycle --budget 20` |
| Répertoire de travail | `www/webpool` |
| Environnement | `NODEJS_VERSION=24` |
| Fréquence | `0 4 * * 1` (lundi, 4 h) |

Avec 20 appels par semaine, le coût reste autour de 0,11 $ (OpenRouter, moteur
Perplexity).

Les recherches payantes ont leur propre tâche, à la même configuration :
commande `node bin/webpool.js requests run`, fréquence `*/15 * * * *`. Le verrou
du pipeline l'empêche de tourner en même temps qu'une autre exécution ou que
`cycle` ; elle ne fait rien sans recherche en attente. Ne pas déployer pendant un passage : la tâche tourne dans le
répertoire que la bascule remplace.

`cycle` explore, normalise, classe et rafraîchit tous les pools. Pour une chaîne
à la main sans exploration, enchaîner `ingest`, `normalize`, `classify` et un
`pool refresh --slug` par pool.

Les journaux vont dans `~/admin/logs/jobs/`. Une exécution encore en cours fait
sauter la suivante : espacer les tâches lourdes (`normalize` en ligne respecte
`WEBPOOL_HOST_DELAY_MS` par hôte).

## Structure

| Chemin | Rôle |
|---|---|
| `db/migrations/` | Migrations versionnées, `001_init.sql` = schéma initial (url_item, url_source, theme, url_theme, facet_definition, url_facet_value, pool, pool_item, processing_run) ; `002` à `010` : domain_profile, search_query, search_query_run, exclusion_hash, api_client, tuyaux, url_media, communautés, portefeuilles et recherches payantes, rétention du grand livre et pools publics |
| `src/ingest/` | Providers SERP (`file`, `brave`, `searxng`, `europeana`, `flickr`, `openrouter`) + insertion tracée |
| `src/normalize/` | Canonisation stricte (tracking, redirections, dédup domaine+canonique), fetch poli |
| `src/classify/` | Classifieur par règles piloté par `config/taxonomy.json` |
| `src/migrate.js` | Runner de migrations (`webpool migrate`) |
| `src/explore/` | Frontière de requêtes, exclusion des domaines saturés, `explore` (fonctions pures dans `frontier.js` et `exclusion.js`) |
| `src/domains/` | Registre des domaines et facette `usage-commercial` |
| `src/media/` | Type de média et famille de source (`kinds.js`), réduction d'images (`thumbnail.js`, sharp), cache `webpool media` |
| `src/cycle/` | `cycle` : explore, normalize, classify, media, refresh des pools |
| `src/billing/` | Prix des recherches (`pricing.js`, pur), communautés, portefeuilles et grand livre des giri, rapport |
| `src/requests/` | Recherches payantes : achat, annulation, exécution (`requests run`) |
| `src/pools/` | Définition JSON → SQL paramétré → matérialisation rangée → export |
| `src/api/` | API HTTP (`serve`), clients et jetons ; routeur, paramètres et serveur testables sans base |
| `openapi.json` | Contrat de l'API |
| `bin/webpool.js` | CLI |
| `scripts/deploy.mjs` | Déploiement alwaysdata (`pnpm deploy:prod`), fonctions pures dans `deploy-lib.mjs` |
| `deploy/` | Contrat de déploiement, exemple de cible (`targets.json` ignoré par git) |
| `test/` | Tests unitaires (vitest) des fonctions pures |
| `test/integration/` | Tests des couches DB (PostgreSQL local) |

## Tests

```bash
pnpm test               # fonctions pures, aucune base requise
pnpm db:up
pnpm test:integration   # couches DB (ingest, normalize, classify, pools, explore, cycle, API)
pnpm test:coverage      # les deux suites, couverture de src/ (rapport HTML dans coverage/)
pnpm lint               # ESLint
```

`test:coverage` exige la base et échoue sous les planchers fixés dans
`vitest.coverage.config.js` (instructions 95 %, branches 90 %, fonctions 93 %,
lignes 97 %). `bin/webpool.js` n'est pas compté : `test/cli.test.js` le lance dans
un processus séparé, que la mesure ne suit pas.

La suite d'intégration utilise le PostgreSQL docker local dans un schéma jetable créé
puis supprimé par fichier de test, remis à zéro entre les tests. Elle charge `.env` et
calcule la même URL que le CLI (`DATABASE_URL`, sinon `localhost:${WEBPOOL_DB_PORT:-5432}`).

Sur un poste, elle est ignorée avec un avertissement si la base est injoignable.
`WEBPOOL_IT_REQUIRED=1` la rend obligatoire : une base injoignable fait alors échouer
la commande. La CI GitHub Actions (`.github/workflows/ci.yml`, Node 22 et 24, service
`postgres:17-alpine`) la rend obligatoire d'office et exécute les deux suites à chaque
push et pull request, après `pnpm lint`, via `pnpm test:coverage`.

## Licence

[MIT](LICENSE). Voir aussi <https://www.scriptami.com/applications/>.
