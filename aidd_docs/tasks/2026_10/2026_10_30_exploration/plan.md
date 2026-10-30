---
objective: "Une commande planifiable fait découvrir à webpool, run après run, des domaines qu'il ne connaissait pas, pour tout type de ressource, et le droit d'usage commercial devient une facette qualifiée une fois par domaine."
status: implemented
---

<!-- Fill or omit these sections; never add, rename, or reorder one. -->

# Plan: Boucle d'exploration — des sources de plus en plus rares

## Overview

| Field      | Value |
| ---------- | ----- |
| **Goal**   | Passer d'un rejeu de requêtes figées à une exploration qui priorise ce qui rapporte des domaines nouveaux, pagine, écarte les domaines saturés et classe les pools par rareté. |
| **Source** | Demande en conversation du 2026-10-30 : « creuser de plus en plus loin pour avoir d'autres sources plus rares avec le temps » ; « pour tout type de ressources […] le droit commercial c'est juste une facette ». Retenus : frontière de requêtes avec rendement et pagination, exclusion des domaines saturés, registre des domaines qualifiés une fois, ordre « rareté », requêtes de départ multilingues écrites à la main. Hors périmètre : génération automatique de requêtes depuis le corpus (plan ultérieur). |

## Phases

| #   | Phase | File |
| --- | ----- | ---- |
| 1   | Registre des domaines et facette `usage-commercial` | [`phase-1.md`](./phase-1.md) |
| 2   | Frontière de requêtes, pagination et commande `explore` | [`phase-2.md`](./phase-2.md) |
| 3   | Exclusion des domaines saturés | [`phase-3.md`](./phase-3.md) |
| 4   | Ordre `rarity` dans les pools | [`phase-4.md`](./phase-4.md) |
| 5   | Commande `cycle`, requêtes de départ, documentation | [`phase-5.md`](./phase-5.md) |
| 6   | Mise en production et tâche planifiée | [`phase-6.md`](./phase-6.md) |

## Resources

| Source | Verified |
| ------ | -------- |
| https://api-dashboard.search.brave.com/app/documentation/web-search/query | `count` ≤ 20 ; `offset` = numéro de page 0-based, max 9 (donc 200 résultats par requête au plus) ; les opérateurs (`site:`, `-terme`, guillemets) vont dans `q`. `-site:` n'y est pas documenté ; aucune longueur maximale de `q` n'y est indiquée. |
| Essai réel du 2026-10-30 (Brave, depuis alwaysdata) | `site:` est respecté (24 requêtes, 0 résultat hors site) ; `-site:gettyimages.com` a écarté gettyimages.com mais pas gettyimages.co.uk ; les requêtes en japonais font émerger des domaines absents des requêtes anglaises (blue-wind.net, yunphoto.net, publicdomainq.net, pakutaso.com, goto-stock.com). |
| Essai `-site:` du 2026-10-30, phase 3 (Brave, depuis alwaysdata) | « free stock photo japan temple » : sans exclusion, 19 résultats dont pexels.com et unsplash.com ; avec `-site:unsplash.com -site:pexels.com` (65 car.), 17 résultats, aucun des deux ; avec 18 `-site:` (378 car.), 17 résultats, aucune fuite, et des domaines absents des deux autres passages (lummi.ai, stockfreeimages.com, pakutaso.com, picryl.com, scapestock.net). L'opérateur est respecté et une requête de 378 caractères est acceptée : la phase est menée en entier. |

## Decisions

| Decision | Why |
| -------- | --- |
| La facette `usage-commercial` (`libre`, `sous-conditions`, `payant`, `non-commercial`, `a-qualifier`) remplace la facette `licence`. | `licence: libre/commerciale` mélangeait la gratuité et le droit d'usage (« commerciale » désignait les banques payantes). Le registre tranche par domaine ; les motifs de la taxonomie ne font que pré-remplir. Validée par l'utilisateur le 2026-10-30, y compris « creative commons » en `sous-conditions`. |
| Le registre (`domain_profile`) a le dernier mot sur les motifs de la taxonomie, et une qualification réécrit immédiatement la facette des URLs du domaine. | Une source rare n'est reconnue par aucun motif ; la qualifier une fois doit suffire, sans reclassifier tout le corpus. |
| Le rendement d'une requête se mesure en domaines nouveaux, pas en URLs nouvelles. | Une requête qui ramène 20 nouvelles pages d'Unsplash n'aide pas à trouver des sources rares. |
| Une requête épuisée n'est pas supprimée : elle redevient éligible, depuis la page 0, après un délai de repos configurable. | Le web change ; le registre de requêtes est l'actif qui s'accumule. |
| Plan clos le 2026-10-30 avec une réserve sur le critère 3 de la phase 6 : `cycle --budget 5` lancé à la main sur le serveur a réussi (5 appels OpenRouter, 87 URLs et 42 domaines nouveaux, 0 erreur, 10 pools rafraîchis), mais aucun passage déclenché par alwaysdata (tâche #37068, `0 4 * * 1`) n'a encore eu lieu ; le journal `~/admin/logs/jobs/2026/37068-2026-11-02.log` reste à lire. | La commande planifiée est celle qui a été validée ; seul le déclenchement par alwaysdata reste à constater. |
| Suite hors plan : les requêtes jamais lancées passent dans l'ordre d'import (`selectQueries`, départage par id), donc les 7 premiers passages sont tous japonais et les pools créatures, psychologie et Saint-Pétersbourg restent vides ; à environ 20 appels par semaine, environ trois semaines pour finir les requêtes de départ. | Sujet de conception distinct, à traiter dans un brainstorm. |
