---
status: implemented
branch: ccr-936abb88-3jmekc
---

# Listes de liens externes : brainstorm et remise en question

Notes de conception de [`plan.md`](./plan.md). Point de départ : la v1 du
2026-11-17 (provider virtuel `list`, soumission par les membres d'une
communauté, payée par le pot, examinée par `requests run`, entrée dans le pool
par `include_requests`). Cas d'usage qui a lancé le sujet : l'admin a réuni une
centaine de liens thématiques sur le Japon et veut les injecter dans un pool.

## Brainstorm

| Piste | Sort |
| ----- | ---- |
| L'admin soumet ses propres listes, pour n'importe quel pool, sans payer | **Retenue.** Le cas d'usage d'origine : aujourd'hui l'admin doit être membre d'une communauté et payer son propre pot. Une soumission d'admin est gratuite (la maison ne se facture pas) et compte pour `include_requests`. |
| Un pool composé uniquement des listes et recherches qui le visent | **Retenue** : `include_requests: "only"`. Sans critère de sujet, `include_requests: true` prend tout le corpus classé ; impossible de faire « le pool de ma sélection Japon ». |
| Compte rendu lien par lien après examen | **Retenue.** Un curateur qui soumet 100 liens doit savoir lesquels sont entrés, lesquels ont échoué (404, hôte refusé, doublon) et pourquoi ; un total ne suffit pas. |
| Formats d'entrée : texte, Markdown, CSV, export de favoris, fichier | **Retenue.** Une liste se tient souvent en Markdown (`- [titre](url)`), en CSV ou en favoris HTML. Lecture des formats côté client (et côté CLI pour l'admin), chargement d'un fichier dans datapool. |
| Relecture humaine avant entrée dans le pool | **Écartée.** L'utilisateur a demandé un examen « identique » à celui des résultats OpenRouter, qui n'en ont pas. Les seuils du pool, les domaines exclus et le compte rendu par lien suffisent ; une file de modération serait un autre chantier. |
| Titre proposé par le membre prioritaire sur celui de la page | **Écartée.** Le titre de la page, lu à la normalisation, fait foi : sinon un membre afficherait un titre trompeur à tous les lecteurs du pool. Le titre proposé sert hors ligne et au classement. |
| Retirer un lien précis d'un pool | **Reportée.** `domains_exclude` retire un domaine ; un retrait par URL demande une liste noire par pool, hors du sujet de l'injection. |
| Listes de plus de 200 liens découpées automatiquement | **Écartée.** Le plafond est réglable (`WEBPOOL_LIST_MAX_LINKS`) ; découper cacherait le prix réel. |

## Remise en question (jusqu'à zéro point bloquant)

| # | Objection | Bloquant ? | Réponse |
| - | --------- | ---------- | ------- |
| 1 | L'admin ne peut pas injecter sa liste sans créer une communauté et payer son propre pot. | **Oui** | Soumission d'admin gratuite, tout pool, API, datapool et CLI (`webpool list submit`). |
| 2 | Aucun pool ne peut ne contenir que les listes soumises. | **Oui** | `include_requests: "only"`. |
| 3 | Le soumetteur ne sait pas quels liens sont entrés ni pourquoi les autres ont échoué. | **Oui** | `GET /requests/{id}/links` et détail dans datapool : statut, erreur, URL canonique, présence dans le pool. |
| 4 | Une liste en Markdown ou en CSV est rejetée ligne à ligne. | **Oui** pour l'usage réel (les listes se tiennent rarement en texte brut) | Lecture des formats Markdown, CSV, favoris HTML et texte, côté datapool et CLI ; chargement d'un fichier. |
| 5 | Une liste d'admin gratuite ouvre-t-elle une injection ? | Non | L'admin modifie déjà les pools et leurs définitions ; il est la maison. |
| 6 | `"only"` vide le pool tant que rien n'a été soumis. | Non | C'est le sens voulu ; le pool se remplit au premier `requests run`. |
| 7 | Prix 0 : le grand livre refuse une écriture de 0 et les prix ≥ 1. | Non | Contrainte relâchée pour les soumissions d'admin (migration) ; aucune écriture au grand livre quand le prix est nul ; aucun remboursement dû. |
| 8 | Le compte rendu par lien révèle-t-il trop ? | Non | Visible du soumetteur, des propriétaires de la communauté qui a payé et de l'admin, comme la recherche elle-même ; les erreurs brutes de réseau restent réservées à l'admin, le client voit une catégorie. |
| 9 | Un lien d'une liste marqué doublon d'une URL déjà connue. | Non | La normalisation reporte les sources sur l'URL survivante : le compte rendu suit la survivante et dit « déjà connu ». |
| 10 | Un fichier HTML de favoris malveillant. | Non | Lu par `DOMParser` côté navigateur (rien n'est exécuté), seuls les `href` http(s) sont gardés ; côté CLI, simple expression régulière sur `HREF`. |
