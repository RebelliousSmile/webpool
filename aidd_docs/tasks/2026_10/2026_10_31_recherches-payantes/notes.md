---
status: implemented
branch: ccr-936abb88-3jmekc
---

# Recherches payantes : brainstorm, remise en question, revue

Notes de conception de [`plan.md`](./plan.md). Le plan garde les décisions ; ce
fichier garde les pistes écartées, les objections, et la revue du plan
(2026-10-31) avec la suite donnée à chaque point.

## Brainstorm

| Piste | Sort |
| ----- | ---- |
| Deux monnaies : crédit en € pour les particuliers, giri pour les communautés | **Fusionnée.** Une seule unité interne, le giri, et un seul grand livre. La distinction de la demande passe dans le canal d'alimentation : un *don* crédite un portefeuille personnel, un *apport* d'un membre le pot de sa communauté (dans une communauté, on ne paie pas pour soi). Un seul prix et un seul chemin de débit ; l'interface affiche aussi l'équivalent en €. |
| Facturer le coût réel après l'appel | **Écartée.** Le prix serait imprévisible et le débit pourrait dépasser le solde. On retient un prix fixe annoncé avant l'achat, et on mesure le coût réel quand le provider le donne (OpenRouter `usage.cost`) pour vérifier la marge (`billing report`). |
| Mettre les recherches payées dans la frontière (`search_query`) | **Écartée.** La frontière a son économie propre : budget de la maison, tuyaux, pression. Une requête payée fausserait la pression des tuyaux, et le budget hebdomadaire de 20 appels la ferait attendre une semaine. Elle va dans une file à part, `search_request`. |
| Exécuter la recherche dans l'API, au `POST` | **Écartée.** Un appel OpenRouter prend de 3 à 11 s, et l'API tourne dans un site Node.js. L'API inscrit et débite ; une tâche planifiée exécute (`webpool requests run`, toutes les 15 min). |
| Recherche « illimitée » qui pagine tant qu'elle trouve | **Écartée.** Son coût serait illimité. Une recherche achète `pages` appels (1 à `WEBPOOL_REQUEST_MAX_PAGES`, une seule pour OpenRouter qui ne pagine pas) ; les pages non lancées sont remboursées. |
| Paiement en ligne intégré (Stripe Checkout + webhook) dès maintenant | **Reportée.** Il faut un compte, des clés, des CGV et un choix juridique. La v1 enregistre les crédits à la main (`wallet credit`), avec une référence de paiement unique. L'URL de don est configurable (`WEBPOOL_FUNDING_URL`). |
| Transferts de giri entre portefeuilles, remboursement en € | **Écartée.** La monnaie reste en circuit fermé (voir plus bas). |
| Plafond de dépense par membre de communauté | **Retenue.** Sans plafond, un membre peut vider le portefeuille commun : `community join --monthly N` (CLI) ou `PUT /communities/{slug}/members/{name}` (propriétaires) fixe un plafond en giri sur 30 jours glissants. |
| Résultats d'une recherche forcés dans le pool visé | **Retenue, sur option du pool, pour les seules recherches de ses communautés.** Le critère `include_requests: true` fait entrer les URLs des recherches payées par une communauté propriétaire du pool, sans remplir ses critères de sujet ; ses seuils de qualité et `domains_exclude` s'appliquent toujours. |
| Inscription en libre-service pour l'accès gratuit | **Reportée.** Créer des jetons sans contrôle ouvre l'API au premier robot venu (quotas, encours de giri sans titulaire identifié). Les pools publics donnent l'accès gratuit à tout client ; le jeton reste créé par l'admin. |

## Remise en question

| Risque ou objection | Réponse retenue |
| ------------------- | --------------- |
| **Le provider `file` lit un fichier du serveur** dont le chemin est la requête. | Refusé en dur pour les recherches, quelle que soit la configuration. |
| Les providers gratuits (SearXNG, Europeana, Flickr) ne coûtent rien en tokens. | Ils consomment des quotas, la normalisation, la classification et le cache de médias : prix plancher de 1 giri par appel. |
| Un « don » qui donne droit à un service n'est pas un don au sens fiscal. | C'est un **prépaiement** : aucun reçu fiscal, TVA possible selon le statut de l'éditeur. À valider avec un comptable avant d'encaisser à grande échelle. |
| Une monnaie virtuelle achetée peut relever de la monnaie électronique. | Le giri ne se dépense qu'en recherches webpool, ne se transfère pas, ne se rembourse pas en € : exclusion « réseau limité » (DSP2, art. 3 k). Aucune fonction de transfert. |
| Un membre de communauté peut vider le portefeuille commun. | Plafond par membre sur 30 jours glissants ; seuls les propriétaires voient le grand livre et toutes les recherches de la communauté. |
| `include_requests` permet à quiconque voit le pool et paie d'y injecter des URLs. | Seules comptent les recherches payées par une communauté propriétaire du pool : une recherche personnelle n'entre pas par cette voie, même sur un pool public. Désactivé par défaut ; seuils et `domains_exclude` toujours appliqués. |
| Double débit, solde négatif sous concurrence. | Débit par `UPDATE … WHERE balance + delta >= 0` dans la transaction qui écrit l'écriture et la recherche ; `CHECK (balance >= 0)` en dernier rempart. |
| Recherche bloquée en `running` après un crash. | `requests run` clôt les recherches `running` depuis plus d'une heure et rembourse les appels non faits. |
| Spam de recherches. | 200 caractères au plus, `WEBPOOL_REQUEST_MAX_QUEUED` (5) recherches en attente par client, annulation par l'auteur ou l'admin. |
| L'API n'était plus censée qu'être lue. | Elle écrit dans `search_request`, `wallet`, `wallet_entry` et `community_member` (propriétaires), et dans eux seuls ; le README donne les `GRANT`. |
| Prix arrondi au giri entier. | 1 € = 1 000 giri : l'arrondi au giri supérieur reste sous 10 % sur les prix actuels (Brave 9,2 → 10, OpenRouter 10,12 → 11). |
| Le cours USD → EUR bouge, des appels ne rendent rien. | `WEBPOOL_USD_EUR` et une majoration ×2 (`WEBPOOL_PRICE_MARKUP`) ; `billing report` compare recettes et coût. La majoration ne couvre **pas** les frais fixes de paiement : voir le crédit minimal. |

## Revue du plan (2026-10-31)

| # | Constat | Suite donnée |
| - | ------- | ------------ |
| 1 | Le plan ajoutait deux sections (« Brainstorm », « Remise en question ») alors que le gabarit l'interdit. | Corrigé : déplacées dans ces notes. |
| 2 | Commande inexacte : `community member add --limit N` n'existe pas. | Corrigé : `community join --monthly N`. |
| 3 | « La majoration couvre les frais de paiement » est faux pour les frais fixes (≈ 0,25 € par transaction) : un don de 0,05 € coûte plus qu'il ne rapporte. | Corrigé : crédit minimal `WEBPOOL_MIN_CREDIT_CENTS` (2 €), `wallet credit --force` pour un paiement déjà reçu. |
| 4 | `include_requests` contournait aussi `min_relevance` et `min_quality` : une URL de pertinence 0 entrait dans le pool. | Corrigé : seuls les critères de sujet sont contournés ; les seuils s'appliquent toujours (`src/pools/criteria.js`, test dédié). |
| 5 | « Accès gratuit aux pools » supposé acquis : seul un accord pool par pool, posé par l'admin, ouvrait un pool. | Corrigé en partie : pools publics (`pool publish`), visibles et exportables par tout client sans accord. L'inscription en libre-service reste reportée (phase *Plus tard*). |
| 6 | Les communautés dépendaient de l'admin pour tout. | Corrigé en partie : les propriétaires gèrent membres, rôles et plafonds par l'API et datapool ; la communauté garde toujours un propriétaire actif. L'achat de giri reste saisi par l'admin tant que le paiement en ligne n'existe pas. |
| 7 | Supprimer un client ou une communauté effaçait en cascade son portefeuille et ses écritures : pièces comptables perdues. | Corrigé : clés étrangères du grand livre en `ON DELETE RESTRICT` (migration `009`, non encore publiée, donc modifiée en place) ; on révoque le client. |
| 8 | `requests run` et `cycle` pouvaient normaliser la même file en même temps : risque absent du plan. | Corrigé : verrou consultatif du pipeline partagé (`src/lock.js`) ; `requests run` passe son tour, `cycle` attend. |
| 9 | Les giri non dépensés sont une dette sans politique. | Décidé : pas d'expiration (simple, honnête pour un prépaiement de faible montant) ; l'encours est suivi par `billing report`. À revoir si l'encours grossit. |
| 10 | (Audit sécurité, même jour) `include_requests` laissait tout client qui voit le pool y injecter des URLs payées sur son portefeuille personnel ; les pools publics étendaient le risque à tous les clients, et les seuils n'arrêtent pas une page conçue pour eux. | Corrigé : seules les recherches payées par une communauté propriétaire du pool comptent (test d'intégration dédié). |
| 11 | (Précision de l'utilisateur) Dans une communauté, on ne paie pas individuellement : on ajoute du giri pour la communauté. | Apports des membres au pot commun, attribués (`--by`) ; recherche sur un pool de la communauté toujours payée par son pot, jamais en personnel ; apports visibles (`contributed`). |
