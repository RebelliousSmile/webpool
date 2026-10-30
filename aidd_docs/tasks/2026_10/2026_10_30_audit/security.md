# Codebase Audit: security

Le SQL est entièrement paramétré (et `ORDER BY` passe par une liste blanche) et l'export CSV est protégé contre l'injection de formules. Les risques réels sont l'exposition réseau de la base, le SSRF du fetcher et la confiance accordée au `canonical` déclaré par les pages.

- **Date**: 2026_10_30
- **Scope**: security — `src/`, `bin/`, `docker-compose.yml`
- **Health**: good
- **Findings**: 0 critical, 3 warning, 2 minor

## Findings

| Sev | Category | Location                       | Issue | Suggested fix | Effort |
| --- | -------- | ------------------------------ | ----- | ------------- | ------ |
| 🟡  | security | `docker-compose.yml:12`        | Le port est publié sur toutes les interfaces. Vérifié : `docker compose port db 5432` renvoie `0.0.0.0:5433`. Les identifiants sont triviaux (`webpool`/`webpool`, lignes 9-10), donc la base est accessible depuis le réseau local. | Publier en `"127.0.0.1:${WEBPOOL_DB_PORT:-5432}:5432"`, et lire le mot de passe dans `.env`. | S |
| 🟡  | security | `src/normalize/fetcher.js:77`  | SSRF : toute URL issue d'un SERP ou d'un fichier est récupérée avec `redirect: 'follow'`, sans aucun filtre d'hôte. `localhost`, `10.x`, `192.168.x`, `169.254.169.254` et les autres conteneurs Docker sont joignables, et une redirection externe peut mener vers ces adresses. | Résoudre le DNS et refuser les adresses loopback, privées ou link-local. Gérer les redirections manuellement (`redirect: 'manual'`) en revalidant chaque saut. | M |
| 🟡  | security | `src/normalize/index.js:20`    | Le `<link rel="canonical">` déclaré par la page est accepté même s'il pointe vers un autre domaine. Une page peut ainsi prendre l'URL et le domaine d'un site de `quality_domains` (bonus de qualité de +0,1), ou être fusionnée avec une URL légitime. | N'accepter le canonical que sur le même hôte ou le même domaine enregistrable. Sinon, garder l'URL finale et conserver le canonical comme simple métadonnée. | S |
| 🟢  | security | `src/config.js:14`             | La valeur par défaut de `DATABASE_URL` contient un mot de passe en clair (`webpool:webpool`). C'est acceptable en développement local, mais elle s'applique silencieusement hors de ce contexte. | Garder ce défaut uniquement quand `NODE_ENV` est absent ou vaut `development`, sinon exiger la variable. | S |
| 🟢  | security | `src/pools/export.js:50`       | Dans l'export Markdown, `mdCell` échappe `\|` mais pas le HTML : un titre web contenant `<img onerror=…>` est injecté tel quel si le `.md` est rendu en HTML. | Échapper `<`, `>` et `&` dans `mdCell`. | S |

## Top actions

1. Lier le port PostgreSQL à `127.0.0.1` (S, la correction a le meilleur rapport impact/effort).
2. Ajouter une garde SSRF au fetcher, sur la cible initiale comme sur chaque redirection.
3. Restreindre le `canonical` déclaré au même domaine.

## Coverage

- **Scanned**: security — validation des entrées (CLI, définitions de pool, fichiers SERP), injection SQL (tout est paramétré, OK), secrets dans le code (aucune clé ; les clés d'API vont dans les query strings Europeana et Flickr comme ces API l'imposent, et ne sont pas loggées), désérialisation (`JSON.parse` uniquement), CSV (formules neutralisées, OK).
- **Skipped**: authentification et autorisations (sans objet : CLI local, aucun endpoint). Aucun outil SAST, revue statique manuelle. Le fichier `.env.example` n'a pas pu être lu, car les permissions locales refusent `.env*`.
