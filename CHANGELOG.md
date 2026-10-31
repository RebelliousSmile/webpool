# Changelog

Toutes les évolutions notables de ce projet sont consignées ici.
Format : [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), versions [SemVer](https://semver.org/lang/fr/).

## [Unreleased]

### Added

- Recherches payantes : les pools restent gratuits, une recherche se paie d'avance en giri (1 € = 1 000 giri), sur le portefeuille d'un client (don) ou d'une communauté (achat). Prix d'un appel = coût du provider majoré (`WEBPOOL_PRICE_MARKUP`), pages non lancées et appels en échec remboursés. Communautés (`webpool community`), membres avec plafond sur 30 jours, pools visibles par les membres ; grand livre (`webpool wallet credit|adjust|show`, référence de paiement unique) ; `webpool pricing`, `webpool requests run|list|cancel`, `webpool billing report` ; critère de pool `include_requests` ; coût réel des appels OpenRouter (`usage.cost`) ; migration `009_billing`.
- API : `GET /billing`, `GET /billing/entries`, `GET|POST /requests`, `DELETE /requests/{id}`, `GET /admin/requests` ; corps JSON borné à 8 Ko, prévol CORS par chemin (`POST`, `DELETE`, en-tête `Content-Type`).
- Pools publics (`webpool pool publish|unpublish`, champ `public`) : visibles et exportables par tout client sans accord.
- Membres d'une communauté gérés par ses propriétaires : `GET /communities/{slug}/members`, `PUT|DELETE /communities/{slug}/members/{name}` ; la communauté garde un propriétaire actif.
- Crédit minimal (`WEBPOOL_MIN_CREDIT_CENTS`, 2 € ; `wallet credit --force`), encours des giri non dépensés dans `billing report`.
- Verrou du pipeline partagé par `cycle` et `requests run` (`src/lock.js`) : jamais deux normalisations de la même file en même temps.

- Export des pools ouvert aux clients `read` (`GET /api/v1/pools/{slug}/export`), sans définition ni score ; format `txt` (une URL par ligne) pour l'API et `pool export` ; usage commercial dans le corpus (`/admin/urls`).
- Déploiement de l'API : site Node.js alwaysdata (`webpool serve`), redémarré après la bascule (API alwaysdata avec `ALWAYSDATA_API_TOKEN` local et `apiSiteId`, sinon consigne), contrôle de `/health` qui renvoie la version et le commit livré (`REVISION`) ; cache de médias créé et `WEBPOOL_MEDIA_DIR` vérifié ; opération `deploy:api` au contrat.
- Médias des liens : description, type de média, langue et nom du site lus à la normalisation ; vignettes (aperçu de la page, sinon vignette du provider) et favicons mis en cache en WebP par `webpool media` (étape de `cycle`) ; champs `description`, `media_type`, `source`, `thumbnail`, `favicon` dans l'API, fichiers servis par `/api/v1/media/{empreinte}.webp` ; migration `008_url_media`, dépendance `sharp`.
- API HTTP en lecture seule : `webpool serve`, routes `/api/v1` (pools, corpus, taxonomie, domaines, frontière, runs, export), contrat `openapi.json`.
- ESLint (`pnpm lint`) et couverture des deux suites réunies (`pnpm test:coverage`, planchers), exécutés par la CI.
- Clients de l'API par jeton (`webpool client add|list|revoke|grant|ungrant`), migration `005_api_client` : scope `admin` ou `read` limité aux pools accordés.
- Exploration par tuyaux : les requêtes étiquetées `flot:<slug>` forment un tuyau, `explore` ne lance que le tuyau courant et le quitte quand sa pression (domaines nouveaux bien notés par appel jugé) tombe sous `WEBPOOL_PIPE_DROP_RATIO` × sa référence ou qu'il n'a plus de requête active ; `webpool pipe list` ; migrations `006_domain_run` et `007_explore_pipe`.
- `query import` ajoute aux requêtes déjà connues les étiquettes qui leur manquent ; exemples étiquetés `flot:<nom>`.

### Fixed

- `/admin/runs?kind=media` refusé alors que `webpool media` trace des runs `media`.
- `openapi.json` livré au déploiement : `/api/v1/openapi.json` aurait répondu 500 en production.
- Test des critères `recent` : la regex contenait un caractère de contrôle au lieu de `\b` et ne vérifiait rien.
- Une variable `PORT` invalide n'arrête plus les commandes quand `WEBPOOL_API_PORT` est défini.
- Erreurs de repli de provider et de connexion au déploiement : cause d'origine conservée (`cause`).

## [v0.1.0] - 2026-10-30

### Added

- Socle Node ESM + pnpm, filiation image-sources-rater (#1).
- Schéma PostgreSQL complet (url_item, sources, taxonomie, facettes, pools, runs) et docker compose (#2).
- Ingestion SERP tracée par requête, provider, rang et date : providers `file` et `brave` (#3), puis `searxng`, `europeana` et `flickr` (#11).
- Normalisation stricte : paramètres de tracking retirés, redirections suivies, URL canonique calculée, déduplication domaine + canonique (#4).
- Classification par règles : taxonomie unique, thème principal, sous-thèmes, facettes, scores (#5).
- Pools matérialisés depuis une définition JSON réexécutable, sélection rangée, CLI `webpool` (#6).
- Export de pool en json, csv ou md, sur stdout ou dans un fichier, définition incluse (#12).
- Normalisation en ligne polie : délai par hôte, retry avec backoff, corps borné au `<head>`, concurrence bornée (#10).
- Tests d'intégration sur base réelle (#9), rendus contraignants (`WEBPOOL_IT_REQUIRED`), et CI GitHub Actions.
- Migrations versionnées : commande `webpool migrate`, table `schema_migration`, baseline `001` sur une base existante, verrou consultatif ; `db/init` devient `db/migrations`.
- `pool create --force` pour remplacer un pool existant ; `WEBPOOL_NORMALIZE_CHUNK` pour la taille des blocs de normalisation.

### Changed

- Classification : requêtes sources pondérées, égalités départagées sans dépendre de l'ordre de la taxonomie (#8) ; correspondance en début de mot, facettes calculées sur le contenu propre.
- Normalisation par blocs ; ingest, classify et refresh de pool en écritures groupées (`unnest`).
- `classify --all` paginé ; synchronisation de taxonomie transactionnelle, avec suppression des entrées absentes.
- Critères de pool typés et validés, `--limit` validé, configuration gelée, User-Agent versionné.
- Dépendances : vitest 4.1.12, pg 8.23.1, engines `^22.12 || >=24`.
- Base locale liée à la boucle locale ; nom de projet docker compose explicite (`webpool`).
- README vitrine : licence MIT, exemple de pool réel, documentation export, providers et tests (#13).

### Fixed

- Réponses 3xx sans location, 4xx et 5xx enregistrées en statut `error` (#10).
- Une URL ingérée qui est une variante doublon est rattachée à son URL survivante.
- Export Markdown : contenu échappé.

### Security

- Garde SSRF à la normalisation (`net.BlockList`, opt-out `WEBPOOL_ALLOW_PRIVATE_HOSTS`), redirections manuelles bornées, URL canonique acceptée seulement sur le même domaine.
