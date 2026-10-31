---
objective: "Les pools restent gratuits. Une recherche (appel payant à un provider) se paie d'avance en giri : un particulier les obtient par un don, une communauté les achète, et ses membres les dépensent pour ajouter des recherches à ses pools."
status: implemented
---

<!-- Fill or omit these sections; never add, rename, or reorder one. -->

# Plan: Recherches payantes, dons et giri

## Overview

| Field      | Value |
| ---------- | ----- |
| **Goal**   | Ouvrir l'ajout de recherches aux clients de l'API sans que la maison paie leurs tokens : prix fixe par appel, calculé sur le coût du provider majoré, débité d'avance sur un portefeuille (personnel ou de communauté), remboursé si l'appel échoue. |
| **Source** | Demande du 2026-10-31 : « accès gratuit aux pools ; pour faire des recherches, un don en rapport avec le coût des tokens majoré ; pour les communautés, acheter une monnaie virtuelle, le giri, qui permet aux membres d'ajouter des recherches dans les pools de la communauté ». |

## Brainstorm

Pistes envisagées, avec le sort de chacune :

| Piste | Sort |
| ----- | ---- |
| Deux monnaies : crédit en € pour les particuliers, giri pour les communautés | **Fusionnée.** Une seule unité interne, le giri, et un seul grand livre. La distinction de la demande passe dans le canal d'alimentation : un *don* crédite un portefeuille personnel, un *achat* le portefeuille d'une communauté. Un seul prix et un seul chemin de débit, et l'interface affiche aussi l'équivalent en €. |
| Facturer le coût réel après l'appel | **Écartée.** Le prix serait imprévisible et le débit pourrait dépasser le solde. On retient un prix fixe annoncé avant l'achat, et on mesure le coût réel quand le provider le donne (OpenRouter `usage.cost`) pour vérifier la marge (`billing report`). |
| Mettre les recherches payées dans la frontière (`search_query`) | **Écartée.** La frontière a son économie propre : budget de la maison, tuyaux, pression. Une requête payée fausserait la pression des tuyaux, et le budget hebdomadaire de 20 appels la ferait attendre une semaine. Elle va dans une file à part, `search_request`, exécutée par `requests run`. |
| Exécuter la recherche dans l'API, au `POST` | **Écartée.** Un appel OpenRouter prend de 3 à 11 s, et l'API tourne dans un site Node.js. L'API ne fait qu'inscrire et débiter ; une tâche planifiée exécute (`webpool requests run`, toutes les 15 min). |
| Recherche « illimitée » qui pagine tant qu'elle trouve | **Écartée.** Son coût serait illimité. Une recherche achète `pages` appels (1 à `WEBPOOL_REQUEST_MAX_PAGES`, une seule pour OpenRouter qui ne pagine pas) ; les pages non lancées sont remboursées. |
| Paiement en ligne intégré (Stripe Checkout + webhook) dès maintenant | **Reportée.** Il faut un compte, des clés, des CGV et un choix juridique (voir *Remise en question*). La v1 enregistre les crédits à la main (`wallet credit`), avec une référence de paiement unique : un don reçu sur Liberapay, Ko-fi ou par virement est crédité une seule fois. L'URL de don est configurable (`WEBPOOL_FUNDING_URL`). |
| Transferts de giri entre portefeuilles, remboursement en € | **Écartée.** Voir *Remise en question* : la monnaie reste en circuit fermé. |
| Plafond de dépense par membre de communauté | **Retenue.** Sans plafond, un membre peut vider le portefeuille commun. `community member add --limit N` fixe un plafond en giri sur 30 jours glissants. |
| Résultats d'une recherche forcés dans le pool visé | **Retenue, sur option du pool.** Un pool est défini par des critères : une recherche payée qui ne les remplit pas n'y entrerait pas. Le critère `include_requests: true` y fait entrer les URLs classées trouvées par les recherches qui visent ce pool. `domains_exclude` s'applique toujours. |

## Remise en question

| Risque ou objection | Réponse retenue |
| ------------------- | --------------- |
| **Le provider `file` lit un fichier du serveur** dont le chemin est la requête. | Refusé en dur pour les recherches, quelle que soit la configuration (`WEBPOOL_REQUEST_PROVIDERS` ne peut pas l'ouvrir). |
| Les providers gratuits (SearXNG, Europeana, Flickr) ne coûtent rien en tokens. Faut-il les ouvrir gratuitement ? | Non. Ils consomment des quotas, la normalisation, la classification et le cache de médias. Le prix plancher est de 1 giri par appel. |
| Un « don » qui donne droit à un service n'est pas un don au sens fiscal. | L'interface parle de don, comme le demande l'utilisateur, mais la documentation précise qu'il s'agit d'un **prépaiement** : il n'ouvre droit à aucun reçu fiscal et peut relever de la TVA selon le statut de l'éditeur. À valider avec un comptable avant d'encaisser à grande échelle. |
| Une monnaie virtuelle achetée peut relever de la monnaie électronique. | Le giri reste en circuit fermé : il ne se dépense qu'en recherches webpool, ne se transfère pas, ne se rembourse pas en € et ne se convertit en rien. C'est le cadre de l'exclusion « réseau limité » (DSP2, art. 3 k) ; aucune fonction de transfert n'est donc implémentée. |
| Un membre de communauté peut vider le portefeuille commun. | Plafond par membre sur 30 jours glissants ; seuls les propriétaires (`owner`) voient le grand livre et toutes les recherches de la communauté. |
| `include_requests` permet à quiconque voit le pool et paie d'y injecter des URLs. | Le critère est un choix explicite de l'admin, par pool, et désactivé par défaut. Les URLs passent par la normalisation et la classification, et seules les URLs classées entrent. Pour payer sur le portefeuille d'une communauté, le pool visé doit appartenir à cette communauté. |
| Double débit, solde négatif sous concurrence. | Le débit est un `UPDATE … WHERE balance >= prix`, dans la transaction qui écrit l'écriture du grand livre et la recherche. `CHECK (balance >= 0)` en dernier rempart. |
| Recherche bloquée en `running` après un crash. | Au démarrage, `requests run` clôt les recherches `running` depuis plus d'une heure et rembourse les appels non faits. |
| Spam de recherches. | Requête de 200 caractères au plus, `WEBPOOL_REQUEST_MAX_QUEUED` (5) recherches en attente par client, annulation par l'auteur (remboursée), `requests list` et `requests cancel` pour l'admin. |
| L'API n'était plus censée qu'être lue (rôle PostgreSQL `SELECT`). | Elle écrit désormais dans `search_request`, `wallet` et `wallet_entry`, et dans eux seuls. La documentation donne les `GRANT` nécessaires. |
| Prix arrondi au giri entier : avec 1 giri = 1 centime, OpenRouter (≈ 0,005 €) coûterait 2 giri, soit ×4. | 1 € = 1 000 giri par défaut (`WEBPOOL_GIRI_PER_EUR`). L'arrondi au giri supérieur ne dépasse alors pas 10 % sur les prix actuels. |
| Le cours USD → EUR bouge. | `WEBPOOL_USD_EUR` (0,92), et une majoration ×2 par défaut (`WEBPOOL_PRICE_MARKUP`) qui couvre aussi les frais de paiement et les appels sans résultat. `billing report` compare recettes et coût. |

## Phases

| #   | Phase | Contenu |
| --- | ----- | ------- |
| 1   | Schéma et grand livre | Migration `009_billing` : `community`, `community_member`, `community_pool`, `wallet`, `wallet_entry`, `search_request`, `url_source.search_request_id`. Prix (`src/billing/pricing.js`, pur), portefeuilles, CLI `community`, `wallet`, `pricing`. |
| 2   | Exécution des recherches | `webpool requests run` : appels, remboursement des échecs, normalize/classify/media, refresh des pools visés, URLs entrées dans le pool. Coût réel OpenRouter. Critère `include_requests`. `requests list/cancel`, `billing report`. |
| 3   | API | Prise en charge de `POST` et `DELETE` (corps JSON borné, CORS), visibilité des pools par communauté, `GET /billing`, `GET /billing/entries`, `GET/POST /requests`, `DELETE /requests/{id}`, `openapi.json`. |
| 4   | datapool | Écran « Recherches » : soldes, prix, formulaire avec coût et solde après achat, historique ; lien depuis un pool. |
| 5   | *Plus tard* | Paiement en ligne (Stripe Checkout ou Liberapay, webhook qui appelle `credit` avec la référence du paiement), CGV et mentions, plafonds éditables par les propriétaires, tableau de bord admin des recettes. |

## Decisions

| Decision | Why |
| -------- | --- |
| Prix d'un appel = `max(1, ⌈coût USD × WEBPOOL_USD_EUR × WEBPOOL_PRICE_MARKUP × WEBPOOL_GIRI_PER_EUR⌉)` giri. Coût par défaut : OpenRouter selon le moteur (perplexity 0,0055 $, exa 0,0175 $, parallel 0,016 $), Brave 0,005 $, les autres 0. | Le prix suit le moteur choisi en production sans configuration de plus. Les coûts sont ceux mesurés dans le README (`sources-openrouter`) et le tarif public de Brave. |
| Le prix est figé sur la recherche (`unit_price`) au moment de l'achat. | Un changement de tarif ne touche pas une recherche déjà payée ; le remboursement rend exactement ce qui a été pris. |
| `requests run` arrête une recherche au premier appel en échec ou à la première page vide ; ce qui n'a pas été lancé est remboursé. | Une erreur de provider se répète souvent (clé, crédit) et une page vide annonce les suivantes. Personne ne paie d'appel inutile. |
| Pas de repli OpenRouter → Brave pour une recherche payée. | L'utilisateur a choisi et payé un provider ; l'appel en échec est remboursé. |
| Crédit en € saisi en décimal (`--eur 12,50`), converti en centimes puis en giri entiers (`⌊centimes × giri_par_euro / 100⌋`). | Aucun flottant dans le grand livre. |
| `reference` unique sur `wallet_entry`. | Un même paiement saisi deux fois (relance, double clic) n'est crédité qu'une fois. |
| Les membres voient les pools de leur communauté sans `client grant`. | L'appartenance est la raison d'être de la communauté ; l'accord individuel reste possible à côté. |
