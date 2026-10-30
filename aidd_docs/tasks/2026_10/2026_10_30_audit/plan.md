---
objective: "Les 33 constats de l'audit du 2026-10-30 sont corrigés ou explicitement écartés, et les deux suites de tests tournent en CI sans skip silencieux."
status: in-progress
---

# Plan: Correction des constats de l'audit webpool

## Overview

| Field      | Value |
| ---------- | ----- |
| **Goal**   | Traiter les 12 warnings et 21 minors de l'audit des sept piliers, par lots livrables indépendamment. |
| **Source** | Fichier : `aidd_docs/tasks/2026_10/2026_10_30_audit/report.md` (et les fichiers par pilier du même dossier) |

## Phases

| #   | Phase | File |
| --- | ----- | ---- |
| 1   | Tests d'intégration contraignants, base locale, CI | [`phase-1.md`](./phase-1.md) |
| 2   | Dépendances : vitest 4, pg | [`phase-2.md`](./phase-2.md) |
| 3   | Surface réseau : SSRF, redirections, canonical | [`phase-3.md`](./phase-3.md) |
| 4   | Précision du classifieur | [`phase-4.md`](./phase-4.md) |
| 5   | Défauts de données : ingest, classify --all, taxonomie | [`phase-5.md`](./phase-5.md) |
| 6   | Robustesse et nettoyage (validation, CLI, refactors) | [`phase-6.md`](./phase-6.md) |
| 7   | Performance : traitement par blocs, écritures groupées | [`phase-7.md`](./phase-7.md) |
| 8   | Migrations versionnées | [`phase-8.md`](./phase-8.md) |

Ordre : la phase 1 rend la suite d'intégration fiable avant toute correction de code ; la phase 2 fixe l'outillage de test utilisé par les suivantes. Les phases 3 à 8 sont indépendantes entre elles, sauf 7, qui touche les mêmes fonctions que 5 (`ingest`, `classifyPending`) : faire 5 avant 7.

## Resources

| Source | Verified |
| ------ | -------- |
| Context7 `/vitest-dev/vitest`, `resolveConfig.ts` et guide de migration v4 | `configDefaults`, `fileParallelism`, `setupFiles`, `describe.skipIf` existent toujours en v4 ; `poolOptions` et `workspace` sont supprimés (non utilisés ici) ; pool par défaut `forks`. |
| `pnpm view vitest@4.1.12 engines` / `vitest@5.0.5 engines` | v4 : `^20 \|\| ^22 \|\| >=24` ; v5 : `^22.12 \|\| ^24 \|\| >=26`. Aucune des deux ne déclare Node 23, la version locale (v23.4.0). |
| Sonde Node 23.4 (scratchpad `redir.mjs`) | `fetch(url, { redirect: 'manual' })` renvoie le vrai 301 avec son en-tête `location` (pas de réponse opaque) ; `net.BlockList` filtre les plages IPv4 et IPv6. Garde SSRF faisable sans dépendance. |

## Decisions

| Decision | Why |
| -------- | --- |
| Cible `vitest ^4.1.12`, pas la 5. | Corrige les 12 advisories, et la plage moteur de la v4 est plus large que celle de la v5. Node 23 (hors LTS, en fin de vie) n'est déclaré ni par l'une ni par l'autre : `engines` passe à `^22.12 \|\| >=24` et la CI teste Node 22 et 24. Le poste local doit passer en Node 22 LTS ou 24. |
| La garde SSRF repose sur `dns.lookup` puis `net.BlockList`, avec redirections manuelles revalidées à chaque saut. | Aucune dépendance ajoutée. Risque résiduel accepté : le DNS rebinding entre la résolution et la connexion (la parade complète demande un `dispatcher` undici, donc une dépendance). |
| Le JSON de taxonomie reste la source de vérité : la synchronisation supprime les thèmes et facettes absents du JSON (cascade sur `url_theme` et `url_facet_value`). | Pas de colonne d'archivage, donc pas de dépendance aux migrations. Une classification portant sur un thème retiré est de toute façon périmée ; le prochain `classify --all` la recalcule. |
| Les migrations sont un runner maison (`db/migrations/NNN_*.sql`, table `schema_migration`), `001_init.sql` devient la baseline. | Deux dépendances directes seulement aujourd'hui ; le besoin (SQL brut, ordre linéaire) ne justifie pas un outil tiers. Une base existante qui a déjà `url_item` est marquée baseline sans rejouer `001`. |
| Le canonical n'est accepté que sur le même hôte canonique (`www.` retiré), sans Public Suffix List. | Aucune dépendance. `m.example.com` → `example.com` est refusé : un faux refus conserve l'URL finale, alors qu'une acceptation abusive fusionnerait deux sites. |
| `test/integration/helpers.js` n'importe jamais `src/config.js` ; la configuration partagée passe par `src/env.js`, sans singleton. | `setup.js` importe les helpers avant d'affecter `DATABASE_URL` : charger `config` à ce moment le figerait sur le schéma `public`, que `resetData` tronquerait. |
| Constat `src/config.js:14` (mot de passe dans la `DATABASE_URL` par défaut) : non retenu en l'état. | webpool est un outil local ; une fois le port lié à `127.0.0.1` (phase 1), la valeur par défaut ne sert qu'au conteneur de développement. La phase 1 en dérive le port de `WEBPOOL_DB_PORT` au lieu de le figer. |
