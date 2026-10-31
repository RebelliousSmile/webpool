---
objective: "Les pools restent gratuits. Une recherche (appel payant à un provider) se paie d'avance en giri : un particulier les obtient par un don, une communauté les achète, et ses membres les dépensent pour ajouter des recherches à ses pools."
status: implemented
---

<!-- Fill or omit these sections; never add, rename, or reorder one. -->

# Plan: Recherches payantes, dons et giri

## Overview

| Field      | Value |
| ---------- | ----- |
| **Goal**   | Ouvrir l'ajout de recherches aux clients de l'API sans que la maison paie leurs tokens : prix fixe par appel, calculé sur le coût du provider majoré, débité d'avance sur un portefeuille (personnel ou de communauté), remboursé si l'appel n'a pas lieu. L'accès aux pools reste gratuit, y compris par des pools publics. |
| **Source** | Demande du 2026-10-31 : « accès gratuit aux pools ; pour faire des recherches, un don en rapport avec le coût des tokens majoré ; pour les communautés, acheter une monnaie virtuelle, le giri, qui permet aux membres d'ajouter des recherches dans les pools de la communauté ». Pistes écartées, objections et revue du plan : [`notes.md`](./notes.md). |

## Phases

| #   | Phase | Contenu |
| --- | ----- | ------- |
| 1   | Schéma et grand livre | Migration `009_billing` : `community`, `community_member`, `community_pool`, `wallet`, `wallet_entry`, `search_request`, `url_source.search_request_id`. Prix (`src/billing/pricing.js`, pur), portefeuilles, CLI `community`, `wallet`, `pricing`. |
| 2   | Exécution des recherches | `webpool requests run` : appels, remboursement des échecs, normalize/classify/media, refresh des pools visés, URLs entrées dans le pool. Coût réel OpenRouter. Critère `include_requests`. `requests list/cancel`, `billing report`. |
| 3   | API | `POST`, `PUT` et `DELETE` (corps JSON borné, CORS), visibilité des pools par communauté, `GET /billing`, `GET /billing/entries`, `GET/POST /requests`, `DELETE /requests/{id}`, `openapi.json`. |
| 4   | datapool | Écran « Recherches » : soldes, prix, formulaire avec coût et solde après achat, historique ; lien depuis un pool. |
| 5   | Corrections de la revue | Migration `010` : grand livre en `ON DELETE RESTRICT`, `pool.public`. Pools publics (`pool publish`). Membres gérés par les propriétaires (`/communities/{slug}/members`, datapool), upsert partiel. Crédit minimal, encours dans `billing report`. `include_requests` limité aux recherches des communautés propriétaires, seuils toujours appliqués. Verrou du pipeline partagé par `cycle` et `requests run`. |
| 6   | *Plus tard* | Paiement en ligne (Stripe Checkout ou Liberapay, webhook qui appelle `credit` avec la référence du paiement), achat de giri par les propriétaires eux-mêmes, CGV et mentions, inscription en libre-service avec garde anti-abus, tableau de bord admin des recettes et de l'encours. |

## Decisions

| Decision | Why |
| -------- | --- |
| Une seule unité, le giri (1 € = `WEBPOOL_GIRI_PER_EUR` = 1 000 giri), un seul grand livre ; *don* sur un portefeuille personnel, *apport* d'un membre au pot de sa communauté (`wallet credit --community … --by <membre>`, écriture `purchase` au nom du membre). | Un seul prix, un seul chemin de débit ; la distinction de la demande tient au canal d'alimentation. Dans une communauté, on ne paie pas pour soi : on ajoute des giri pour la communauté, et chaque apport reste attribué. 1 000 giri par euro gardent l'arrondi au giri supérieur sous 10 %. |
| Prix d'un appel = `max(1, ⌈coût USD × WEBPOOL_USD_EUR × WEBPOOL_PRICE_MARKUP × WEBPOOL_GIRI_PER_EUR⌉)` giri. Coût par défaut : OpenRouter selon le moteur (perplexity 0,0055 $, exa 0,0175 $, parallel 0,016 $), Brave 0,005 $, les autres 0. | Le prix suit le moteur choisi en production sans configuration de plus. Les coûts sont ceux mesurés dans le README (`sources-openrouter`) et le tarif public de Brave. Le plancher de 1 giri couvre le traitement des providers gratuits. |
| Le provider `file` n'est jamais ouvert aux recherches. | Il lit un fichier du serveur dont le chemin est la requête. |
| Le prix est figé sur la recherche (`unit_price`) au moment de l'achat, débité dans la transaction qui l'inscrit (`UPDATE … WHERE balance + delta >= 0`). | Un changement de tarif ne touche pas une recherche déjà payée ; pas de solde négatif ni de double débit sous concurrence. |
| L'API inscrit et débite ; `requests run`, tâche planifiée toutes les 15 min, exécute. File à part (`search_request`), hors de la frontière d'exploration. | Un appel prend de 3 à 11 s ; une requête payée ne doit ni fausser la pression des tuyaux ni attendre le budget hebdomadaire. |
| `requests run` arrête une recherche au premier appel en échec ou à la première page vide ; ce qui n'a pas été lancé est remboursé. Pas de repli OpenRouter → Brave. | Personne ne paie d'appel inutile ; l'utilisateur a choisi et payé un provider. |
| `requests run` et `cycle` partagent un verrou consultatif (`src/lock.js`) : `requests run` passe son tour, `cycle` attend. | Ils normalisent et classent la même file `pending`, que `normalizePending` ne réserve pas. |
| Crédit en € saisi en décimal (`--eur 12,50`), converti en centimes puis en giri entiers ; minimum `WEBPOOL_MIN_CREDIT_CENTS` (2 €), `--force` pour un paiement déjà reçu. | Aucun flottant dans le grand livre. Sous 2 €, les frais fixes d'un paiement (≈ 0,25 €) dépassent la majoration, qui ne couvre que les frais proportionnels. |
| `reference` unique sur `wallet_entry`. | Un même paiement saisi deux fois n'est crédité qu'une fois. |
| Les giri n'expirent pas, ne se transfèrent pas et ne se remboursent pas en € ; l'encours est suivi par `billing report`. | Circuit fermé (exclusion « réseau limité » de DSP2) ; pas d'expiration pour un prépaiement de faible montant, à revoir si l'encours grossit. Le « don » est un prépaiement, sans reçu fiscal : à valider avec un comptable. |
| Le grand livre ne se supprime pas : `ON DELETE RESTRICT` du client et de la communauté vers portefeuilles, recherches et écritures (migration `010`, `009` étant publiée). | Pièces comptables gardées 10 ans ; on révoque un client au lieu de le supprimer. |
| Plafond de dépense par membre sur le pot commun, en giri sur 30 jours glissants (débits moins remboursements), posé par l'admin (`community join --monthly N|none`) ou par un propriétaire (`PUT /communities/{slug}/members/{name}`), en upsert partiel ; 0 bloque la dépense. Une communauté garde toujours un propriétaire actif. | Sans plafond, un membre vide le portefeuille commun. Un champ absent ne doit pas effacer l'autre (changer un rôle ne lève pas un plafond). |
| Les membres voient les pools de leur communauté sans `client grant` ; tout client voit les pools publics (`pool publish`). | L'appartenance est la raison d'être de la communauté ; les pools publics sont l'accès gratuit par défaut, sans accord pool par pool. Le jeton reste créé par l'admin : pas d'inscription libre sans garde anti-abus. |
| Une recherche sur un pool d'une des communautés du client se paie toujours sur le pot de la communauté (déduite, ou à préciser si plusieurs possèdent le pool), jamais en personnel ; le pot ne paie que les pools de la communauté. | Précision de l'utilisateur (2026-10-31) : « dans une communauté, on ne paie pas individuellement, on ajoute du giri pour la commu ». Le portefeuille personnel reste pour les recherches hors communauté. Pas de virement du portefeuille personnel vers le pot : ce serait un transfert entre portefeuilles, écarté pour rester en circuit fermé ; un apport passe par un paiement. |
| `include_requests: true` fait entrer les URLs des recherches qui visent le pool **payées par une communauté propriétaire du pool**, sans remplir ses critères de sujet (`theme`, `subthemes`, `facets`, `domains_include`) ; `min_relevance`, `min_quality` et `domains_exclude` s'appliquent toujours. Désactivé par défaut. | Une recherche de la communauté doit pouvoir enrichir son pool. Les seuils seuls n'arrêtent pas un attaquant (audit : une page de phishing hors ligne obtient quality 0,8) : sans la condition de communauté, tout client qui voit le pool, ou tout client pour un pool public, y injecterait des liens pour 1 giri. |
| Achat idempotent (`Idempotency-Key`, unique par client), achats d'un client sérialisés par verrou consultatif de transaction. | Un double clic ou une relance après coupure ne débite qu'une fois ; aucun droit `UPDATE` sur `api_client` pour le rôle de l'API (audit du 2026-10-31). |
| Un client ajouté par un propriétaire est **invité** : ni pools ni pot avant d'avoir accepté ; il peut décliner ou, membre, quitter. L'admin rattache directement. Plafond par défaut d'un nouveau membre : `WEBPOOL_MEMBER_DEFAULT_LIMIT` (1 000 giri / 30 jours). | Un propriétaire ne doit pas pouvoir inscrire quelqu'un sans son accord ; un membre sans plafond pouvait vider le pot. Les noms de clients restent énumérables par un propriétaire (réponse 404 sur un nom inconnu) : ce ne sont pas des secrets, les jetons le sont. |
| Le post-traitement d'une recherche (normalize et classify de ses URLs, refresh de son pool) est marqué `processed_at` seulement s'il a réussi, et repris au `requests run` suivant sinon ; `in_pool` se calcule à la lecture. | Une recherche payée ne doit pas attendre le cycle hebdomadaire parce qu'une étape a échoué une fois ; `in_pool` ne doit pas se figer. |
| `include_requests` : les URLs des recherches de la communauté s'ajoutent après la sélection normale, au plus `limit` de plus. | Une recherche payée apporte toujours ses liens au lieu de les perdre face à `limit`. |
