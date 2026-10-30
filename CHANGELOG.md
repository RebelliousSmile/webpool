# Changelog

Toutes les évolutions notables de ce projet sont consignées ici.
Format : [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), versions [SemVer](https://semver.org/lang/fr/).

## [Unreleased]

### Added

- API HTTP en lecture seule : `webpool serve`, routes `/api/v1` (pools, corpus, taxonomie, domaines, frontière, runs, export), contrat `openapi.json`.
- Clients de l'API par jeton (`webpool client add|list|revoke|grant|ungrant`), migration `005_api_client` : scope `admin` ou `read` limité aux pools accordés.

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
