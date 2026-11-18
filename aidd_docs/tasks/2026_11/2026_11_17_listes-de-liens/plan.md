---
objective: "Injecter dans un pool une liste de liens externes réunie à la main, avec le même examen que les résultats d'une recherche, et savoir ce que chaque lien est devenu."
status: implemented
---

<!-- Fill or omit these sections; never add, rename, or reorder one. -->

# Plan: Listes de liens externes

## Overview

| Field      | Value |
| ---------- | ----- |
| **Goal**   | Compléter la v1 des listes de liens (provider `list`) pour qu'elle serve le cas réel : l'admin comme les membres d'une communauté injectent une liste, dans le format où elle existe, dans un pool qui peut ne contenir qu'elle, et lisent le sort de chaque lien. |
| **Source** | Conversation du 2026-11-17 : « une centaine de liens thématiques sur le Japon, est-ce que je pourrais l'injecter dans un pool ? », puis « les membres d'une commu pourraient avoir un outil pour soumettre des listes de liens, avec une phase d'examen identique à celle des requêtes OpenRouter ». Brainstorm et remise en question : [`notes.md`](./notes.md). |

## Phases

| #   | Phase | Contenu |
| --- | ----- | ------- |
| 1   | Soumissions d'admin | Gratuites, pour tout pool, comptées par `include_requests` ; prix 0 accepté pour elles (migration `016`), sans écriture au grand livre ; `webpool list submit` (CLI). |
| 2   | Pool de listes | `include_requests: "only"` : le pool ne contient que les URLs des recherches et listes qui le visent (communauté propriétaire ou admin), seuils et exclusions appliqués. |
| 3   | Compte rendu par lien | `GET /requests/{id}/links` : position, URL soumise, URL canonique, statut, catégorie d'erreur (brute pour l'admin), présence dans le pool. |
| 5   | Récompense des liens valides | Écriture `reward` au grand livre (migration `017`), table `link_reward` (une récompense par URL) ; attribution au post-traitement de `requests run`, plafonds par domaine et par membre ; montant visible dans `/billing`, dans la recherche et dans le compte rendu par lien. |
| 6   | Envoi direct par l'API | `POST /api/v1/lists` : liste brute (texte, Markdown, CSV, favoris HTML) lue côté serveur ou liens JSON, corps de 256 Ko, lignes ignorées rendues. |
| 4   | Formats d'entrée | Lecture du texte, du Markdown, du CSV et des favoris HTML (datapool, et CLI pour `list submit`) ; chargement d'un fichier dans datapool ; détail par lien dans l'historique. |

## Decisions

| Decision | Why |
| -------- | --- |
| Une soumission d'un client `admin` (liste ou recherche) est gratuite, vise n'importe quel pool et compte pour `include_requests` au même titre que celles d'une communauté propriétaire. | L'admin est la maison : se facturer soi-même n'a pas de sens, et son cas (une liste personnelle pour un pool) n'était pas servi. Il peut déjà modifier tout pool : rien ne s'ouvre. |
| `include_requests: "only"` en plus de `true` ; « only » ignore les critères de sujet et ne retient que les URLs des soumissions qualifiées, triées par l'ordre du pool, `limit` au plus. | Seul moyen de faire « le pool de ma sélection » sans détourner `domains_include`. |
| Compte rendu par lien calculé à la lecture depuis `url_source` (position = rang) et `search_request.links` ; erreurs regroupées en catégories pour les clients (`introuvable`, `hôte refusé`, `erreur réseau`, `doublon`, `hors seuils`). | Rien à stocker de plus ; les messages bruts peuvent contenir des détails d'infrastructure. |
| Formats lus côté client : texte (`url titre`), Markdown (`[titre](url)` ou URL nue), CSV (`url,titre` ou `titre,url`, détection de la colonne URL), favoris HTML (`<a href>`). Le serveur reçoit toujours `[{url, title}]`. | Une seule validation côté serveur ; les formats évoluent sans toucher à l'API. |
| Le titre de la page lu à la normalisation l'emporte sur celui proposé. | Un membre ne doit pas pouvoir afficher un titre trompeur à tous les lecteurs du pool. |
| Un lien valide rapporte `WEBPOOL_LINK_REWARD` giri (2) à qui l'a apporté : lien d'une liste payée par une communauté, entré dans le pool visé (classé, hors quarantaine, seuils passés), **nouveau pour le corpus** au moment de la soumission, jamais récompensé (une récompense par URL, à vie). Au plus `WEBPOOL_LINK_REWARD_DOMAIN_CAP` (5) liens récompensés par domaine et par membre, et `WEBPOOL_LINK_REWARD_MONTHLY_CAP` (1 000) giri par membre, sur 30 jours glissants. | Demande de l'utilisateur (2026-11-17) : « quelqu'un qui amène des liens valides dans le pool gagne du giri ». La récompense crée du giri : sans ces conditions, soumettre des liens connus, des doublons ou des centaines de pages de son propre domaine deviendrait une boucle rentable (prix 1, récompense 2). Les listes d'admin (la maison) et les recherches (le fournisseur trouve, pas la personne) n'en donnent pas. |
| La récompense va sur le portefeuille **personnel**, en écriture `reward`, attribuée au post-traitement, une fois le pool rafraîchi. | Sur le pot, elle compterait comme un apport et ferait devenir propriétaire sans avoir rien payé ; le giri gagné reste en circuit fermé (recherches personnelles). |
| `POST /api/v1/lists` accepte la liste brute (`text`) lue par la même fonction que `webpool list submit`, ou `links` structurés, dans un corps de 256 Ko ; même validation, même prix, même examen que `POST /requests`. | Envoyer une liste « directement avec l'API » sans la mettre en forme côté client ; 8 Ko ne suffisaient pas pour 200 liens. |
