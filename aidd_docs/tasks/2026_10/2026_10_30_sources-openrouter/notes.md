---
status: implemented
branch: feat/pools-thematiques
---

# Sources de recherche : OpenRouter en principal, Brave en repli

## Question

Trouver des sources plus rares que celles de Brave web, sans dépendre d'un seul
fournisseur. Contrainte posée : Brave n'a pas d'intérêt propre, mais il faut
toujours une solution de repli si OpenRouter est inaccessible.

## Sondes (2026-10-30, sur le serveur, corpus de production vide)

Cinq requêtes : `unusual places in Saint Petersburg Russia`,
`заброшенные места Петербурга`, `mutant sea creature concept art`,
`psychology meta-analysis 2025`, `sociology of St Petersburg Russia study`.

| Piste | Résultat |
|---|---|
| Brave web, autres sections de la réponse (`profile`, `thumbnail`, `videos`) | abandonnée : aucune URL utile hors `web.results` |
| Brave Answers (`/res/v1/chat/completions`) | 10 appels en 400 « The option is not included in the plan » : plan séparé, non activé |
| OpenRouter, plugin `web` | 20/20 appels réussis, détail ci-dessous |

OpenRouter : modèle `openai/gpt-4.1-nano`, `plugins: [{ id: 'web', engine, max_results: 20 }]`,
URLs lues dans `message.annotations[].url_citation.url`.

| Mode | Coût par appel | Domaines | Absents de Brave | Domaines absents de Brave par $ |
|---|---|---|---|---|
| Brave web | 0,005 $ (grille officielle, 5 $ / 1 000) | 71 | — | — |
| exa | 0,0175 $ | 66 | 50 | ~570 |
| parallel | 0,0158 $ | 58 | 42 | ~530 |
| perplexity | 0,0055 $ | 55 | 39 | ~1 400 |

Constats :

- Les annotations rendent tous les résultats (toujours 20, soit `max_results`) :
  aucun LLM n'interprète les résultats, le modèle ne sert qu'à porter le plugin.
- Les tokens pèsent 3 à 10 % du coût : appeler les moteurs en direct ne vaut pas
  un client par moteur.
- Recouvrement faible : 70 à 75 % des domaines OpenRouter sont absents de Brave.
  Brave seul sort les grandes plateformes (reddit, quora, tripadvisor) ; les
  moteurs OpenRouter ramènent des sources spécialisées, surtout en russe
  (urban3p.ru, darkspb.ru, sokroma.ru, citynoise.ru, cultbalagan.ru…).
- `exa.ai` remonte comme domaine : artefact du moteur.
- Latence 3 à 11 s par appel.
- Les prix Exa et Parallel dépassent le tarif de base : 10 résultats inclus, puis
  0,001 $ par résultat supplémentaire.
- Brave Answers : 4 $ / 1 000 requêtes plus 5 $ par million de tokens en entrée
  et en sortie, plan prépayé distinct avec 5 $ de crédits par mois. Même index que
  Brave web : sans intérêt comme repli, donc non poursuivi.

Limites : 5 requêtes, un seul passage ; corpus vide, donc pas de mesure
« nouveau pour le corpus ».

## Décision

Provider `openrouter` (moteur `perplexity` par défaut) et repli sur `brave` au
moment de l'appel, sans migration (option 1). Écartée : doubler chaque requête
par provider (option 2), qui double la frontière.

## Mise en œuvre

- `src/ingest/providers/openrouter.js` : POST JSON, `max_tokens: 5`, réponse du
  modèle ignorée ; `OPENROUTER_ENGINE` (`perplexity`, `exa`, `parallel`),
  `OPENROUTER_MODEL`, `OPENROUTER_TIMEOUT_MS` (60 s).
- `src/ingest/providers/http.js` : `fetchJson` accepte `body` (POST) et
  `timeoutMs` ; indice pour HTTP 402 (crédit épuisé).
- `src/explore/index.js` : `FALLBACKS = { openrouter: 'brave' }`. En cas d'échec,
  la requête part sur Brave page 0 avec `-site:` ; le passage compte (priorité),
  les URLs sont tracées sous `brave`, la requête garde page et statut.
- Exclusion des saturés pour OpenRouter par `exclude_domains` (50 au plus, plafond
  choisi, non documenté par OpenRouter).
- `src/explore/frontier.js` : `openrouter` ne pagine pas (`maxPage` = 0), la
  requête s'épuise au premier passage puis revient après le repos.
- Tests : 178 unitaires, 56 d'intégration (port 5433).

## Points ouverts

- Premier appel réel en local réussi (run #10, 20 URLs sur 12 domaines, dont 7
  pages de peterburg2.ru). Il avait d'abord échoué : la variable utilisateur Windows
  `OPENROUTER_API_KEY` portait une clé inconnue d'OpenRouter (401 « User not
  found »). Elle est supprimée ; une variable d'environnement passe avant le
  `.env` (`process.loadEnvFile` n'écrase pas).
- Requêtes d'exemple (`examples/*/queries.json`) encore sur `brave` : à passer sur
  `openrouter` si c'est le provider principal.
