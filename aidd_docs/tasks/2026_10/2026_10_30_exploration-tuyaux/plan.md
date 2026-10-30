---
objective: "L'exploration se concentre sur un tuyau (un sujet), passe au suivant dès que sa pression en domaines nouveaux bien notés baisse, et revient au premier après le dernier, sans jamais s'arrêter."
status: in-progress
---

<!-- Fill or omit these sections; never add, rename, or reorder one. -->

# Plan: Exploration par tuyaux

## Overview

| Field      | Value |
| ---------- | ----- |
| **Goal**   | Remplacer l'ordre d'import des requêtes jamais lancées par une rotation de tuyaux pilotée par la pression : domaines nouveaux bien notés par appel, mesurée par rapport au départ du tuyau. |
| **Source** | Brainstorm en conversation du 2026-10-30. Retenus : le tuyau est le sujet, l'eau ce sont les domaines jamais vus dans le corpus (choix explicite de l'utilisateur : « on ne compte que les nouveaux résultats »), « bien noté » s'appuie sur les notes de `classify`, la baisse est relative au départ du tuyau, la requête reste l'unité d'appel avec la priorité existante à l'intérieur du tuyau, la rotation ne s'arrête jamais. |

## Phases

| #   | Phase | File |
| --- | ----- | ---- |
| 1   | Notes de pertinence pour les requêtes en écriture CJK | [`phase-1.md`](./phase-1.md) |
| 2   | Lien entre chaque domaine nouveau et l'appel qui l'a trouvé | [`phase-2.md`](./phase-2.md) |
| 3   | Tuyaux : pression, bascule et rotation | [`phase-3.md`](./phase-3.md) |
| 4   | Étiquettes `flot:`, documentation et mise en production | [`phase-4.md`](./phase-4.md) |

## Decisions

| Decision | Why |
| -------- | --- |
| Un domaine est « bien noté » quand la meilleure moyenne `(relevance + quality) / 2` de ses URLs classées atteint `WEBPOOL_PIPE_GOOD_SCORE` (0,5 par défaut) ; `confidence` est exclue. | Mesure en production du 2026-10-30 (94 URLs classées) : `quality` est quasi constante (90 URLs entre 0,6 et 0,8), donc seule `relevance` départage ; elle est bimodale (73 URLs sous 0,2, 12 au-dessus de 0,8). `confidence` vaut 0 pour les URLs sans thème (49 sur 71 au dernier cycle). Le seuil 0,5 revient à exiger une `relevance` d'environ 0,25. |
| La phase 1 corrige `relevanceScore` avant tout calcul de pression. | Les termes de 2 caractères ou moins sont ignorés, donc 長崎, 京都 et 写真 ne comptent pas : « 長崎 写真 フリー素材 » n'est jugée que sur フリー素材. Une pression calculée sur ces notes pénaliserait les tuyaux japonais. |
| Le tuyau est déclaré par une étiquette `flot:<slug>` ; une requête sans cette étiquette va dans le tuyau `defaut`. | Les étiquettes `sujet:`/`lieu:` ne suffisent pas : japon n'a pas de `sujet`, Saint-Pétersbourg en a deux. Une étiquette dédiée ne dépend d'aucune règle implicite. |
| La pression est évaluée au début de chaque `explore`, jamais au milieu. | Les notes n'existent qu'après `classify`, qui suit `explore` dans `cycle`. Les appels d'un passage sont donc jugés au passage suivant ; au milieu d'un passage, seule l'absence de requête active fait basculer. |
| Pression = domaines nouveaux bien notés ÷ appels réussis, sur les `WEBPOOL_PIPE_WINDOW` (3) derniers appels du tuyau ; référence = même mesure sur les premiers appels de la visite en cours ; bascule quand la pression est inférieure ou égale à `WEBPOOL_PIPE_DROP_RATIO` (0,5) × référence. | « Relative au départ du tuyau lui-même » : chaque tuyau est comparé à lui-même, pas aux autres. « Inférieure ou égale » fait basculer un tuyau stérile (référence et pression nulles), qui sinon garderait le budget. Une fenêtre de 3 appels lisse un appel isolé sans retarder la bascule de plus d'un passage. |
| La référence est remise à zéro à chaque entrée dans un tuyau, y compris au retour sur le premier. | Avec l'ancienne référence, un tuyau revenu après une rotation complète basculerait dès son premier passage ; les requêtes reposées (`isRested`) et les nouvelles pages méritent une nouvelle mesure. |
| Avec OpenRouter (`MAX_PAGE` = 0), une requête s'épuise en un appel : tant que les requêtes de départ ne sont pas reposées (30 jours), c'est l'épuisement du tuyau qui fait passer au suivant ; la bascule par pression joue surtout sur les requêtes réveillées et sur Brave. | Comportement attendu, à ne pas prendre pour un défaut à la lecture des premiers passages. |
| Les tuyaux tournent dans l'ordre de première apparition de leur étiquette (id de requête le plus petit). | Ordre stable, sans configuration ; il reproduit l'ordre dans lequel l'utilisateur a écrit les requêtes de départ. |
