# Codebase Audit: dependencies

Deux dépendances directes. Les 12 vulnérabilités de `pnpm audit` passent toutes par `vitest` 3, une dépendance de développement.

- **Date**: 2026_10_30
- **Scope**: dependencies — `package.json`, `pnpm-lock.yaml`
- **Health**: good
- **Findings**: 0 critical, 1 warning, 1 minor

## Findings

| Sev | Category     | Location           | Issue | Suggested fix | Effort |
| --- | ------------ | ------------------ | ----- | ------------- | ------ |
| 🟡  | dependencies | `package.json:26`  | `vitest ^3.0.0` (résolu en 3.2.7) entraîne 12 advisories : 2 critiques (tinypool ≤ 2.1.0, prototype pollution menant à une RCE), 3 hautes (vite 7.3.6, source-map-js, nanoid), 6 modérées (path traversal et injection de code dans `@vitest/mocker`) et 1 basse. Elles sont toutes limitées au développement : rien n'est livré en production. Classé warning et non critique pour cette raison. | Passer à `vitest` ≥ 4.1.12 (dernière version : 5.0.5), puis relancer `pnpm audit`. C'est une montée de version majeure : vérifier les configurations vitest. | M |
| 🟢  | dependencies | `package.json:23`  | `pg` 8.22.0 alors que la 8.23.1 est sortie (version mineure). | `pnpm update pg`. | S |

## Top actions

1. Monter `vitest` d'une version majeure, ce qui supprime les 12 advisories. Faire la montée et lancer les deux suites dans la même PR.
2. `pnpm update pg`.

## Coverage

- **Scanned**: dependencies — `pnpm audit` (12 advisories, toutes via `vitest`), `pnpm outdated`, `pnpm licenses list` (MIT, ISC, BSD-3-Clause, Apache-2.0 : rien d'incompatible avec la licence MIT du projet), lockfile présent et commité, aucune dépendance git ou tarball. Aucune dépendance déclarée inutilisée (`pg` et `vitest` sont tous deux importés).
- **Skipped**: none.
