# Codebase Audit: code-quality

Code lisible et cohérent, mais le classifieur produit des faux positifs vérifiés, et deux défauts de logique faussent la traçabilité et le reclassement.

- **Date**: 2026_10_30
- **Scope**: code-quality — `src/`, `bin/`, `config/`
- **Health**: good
- **Findings**: 0 critical, 4 warning, 8 minor

## Findings

| Sev | Category     | Location                         | Issue | Suggested fix | Effort |
| --- | ------------ | -------------------------------- | ----- | ------------- | ------ |
| 🟡  | code-quality | `src/classify/classifier.js:8`   | Correspondance par sous-chaîne sans frontière de mot. Vérifié : « Quick build guide » est classé `design` avec une confiance de 1, parce que `ui` apparaît dans *build*, *guide* et *quick*. `influxdata.com` est classé `design` parce que `ux` apparaît dans *influx*. Le motif de facette `app.` fait classer `whatsapp.com` en `outil`. | Comparer par tokens (découpage `\p{L}\p{N}`, déjà utilisé par `relevanceScore`), ou utiliser une regex avec frontières Unicode, pour les mots-clés comme pour les motifs. | M |
| 🟡  | code-quality | `src/classify/index.js:88`       | `classify --all` sélectionne `normalized` et `classified` avec `ORDER BY id LIMIT 100`. Chaque exécution reprend donc les 100 mêmes premières URLs : au-delà, les URLs ne sont jamais reclassées après un changement de taxonomie. | En mode reclassement, paginer par curseur (`id > $last`) ou trier par `classified_at NULLS FIRST`, ou boucler jusqu'à épuisement. | S |
| 🟡  | code-quality | `src/ingest/index.js:45`         | Quand on réingère une URL déjà marquée `duplicate`, sa nouvelle `url_source` est rattachée à l'item doublon et non à l'URL survivante. La requête est alors perdue pour la classification et pour la traçabilité (`classify` ne lit que les sources de l'URL vivante). | Résoudre `coalesce(duplicate_of, id)` au moment du `SELECT id` qui suit le conflit. | S |
| 🟡  | code-quality | `src/classify/classifier.js:119` | Les facettes sont calculées sur un texte qui inclut les requêtes à poids plein, ce qui contredit la pondération US-08. Vérifié : avec la requête « forest guide », toute URL reçoit `content-type: tutoriel`. | Calculer les facettes sur `own` seul, ou appliquer `QUERY_WEIGHT` comme pour les thèmes. | S |
| 🟢  | code-quality | `bin/webpool.js:57`              | `--limit` n'est pas validé : `Number('abc')` donne `NaN`, et un nombre négatif est accepté. La valeur part dans `LIMIT` et provoque une erreur PostgreSQL peu lisible. | Exiger `Number.isInteger(n) && n > 0`, sinon renvoyer un message d'usage. | S |
| 🟢  | code-quality | `src/pools/criteria.js:83`       | Un `limit` non numérique donne `NaN` (vérifié : `values = [NaN]`). Les types de `theme`, `facets` et `min_*` ne sont pas validés non plus. | Valider les types dans `buildPoolQuery` avant de construire la requête. | S |
| 🟢  | code-quality | `src/config.js:20`               | Les variables d'environnement numériques (`WEBPOOL_*_MS`, `WEBPOOL_CONCURRENCY`) ne sont pas validées : une faute de frappe donne `NaN`, d'où un timeout ou une concurrence incohérents. | Créer un helper `intEnv(name, default)` qui lève une erreur sur une valeur invalide. | S |
| 🟢  | code-quality | `src/ingest/index.js:26`         | Le patron `startRun` → `try` → `finishRun('done' \| 'failed')` est copié quatre fois (ingest, `normalize/index.js:74`, `classify/index.js:85`, `pools/index.js:25`). | Extraire `withRun(kind, detail, fn)` dans `src/run.js`. | S |
| 🟢  | code-quality | `src/ingest/index.js:65`         | `pendingCount` est exporté mais n'est jamais importé (vérifié par grep sur `src`, `bin` et `test`). | Le supprimer. | S |
| 🟢  | code-quality | `src/db.js:25`                   | Si `ROLLBACK` échoue (connexion perdue), son erreur masque l'erreur d'origine. Même risque avec `finishRun` dans les blocs `catch`. | Écrire `await client.query('ROLLBACK').catch(() => {})`, puis relancer `err`. | S |
| 🟢  | code-quality | `src/pools/index.js:11`          | `pool create` sur un slug existant remplace silencieusement la définition (upsert). Le comportement est testé et voulu, mais le nom de la commande ne le laisse pas deviner. | Refuser sur un slug existant, sauf avec `--force` ou une sous-commande `pool update`. | S |
| 🟢  | code-quality | `src/config.js:26`               | La version du User-Agent (`webpool/0.1`) est codée en dur, sans lien avec `package.json`. | La lire depuis `package.json`. | S |

## Top actions

1. Corriger le matching par mots du classifieur (ligne `classifier.js:8`). C'est le problème qui dégrade le plus la qualité des pools. À confier à `aidd-dev:07-refactor`, avec un test de non-régression sur `config/taxonomy.json`.
2. Rattacher les sources réingérées à l'URL survivante (`ingest/index.js:45`) et paginer le reclassement (`classify/index.js:88`). Ce sont deux corrections S, à confier à `aidd-dev:08-debug`.
3. Ne plus laisser les requêtes décider des facettes (`classifier.js:119`), puis valider les entrées numériques du CLI, des définitions de pool et de l'environnement.

## Coverage

- **Scanned**: code-quality (tous les fichiers de `src/`, `bin/webpool.js` et `config/taxonomy.json`). Les faux positifs ont été vérifiés en exécutant `classifyItem` sur la taxonomie réelle.
- **Skipped**: aucun outil de détection des exports inutilisés ; l'absence d'utilisation a été vérifiée par grep.
