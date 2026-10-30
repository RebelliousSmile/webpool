---
status: implemented
branch: feat/pools-thematiques
---

# Pools thématiques : psychologie, créatures, Saint-Pétersbourg

## Demande

Trois pools d'exemple hors photographie : publications de psychologie de 2025,
créatures d'illustration par élément (eau, air), Saint-Pétersbourg sous l'angle
sociologique et des lieux insolites.

## Taxonomie (`config/taxonomy.json`)

- Thèmes : `psychologie`, `sociologie`, `lieux` (sous-thème `insolite`).
- Sous-thème `creatures` sous `illustration`.
- Facettes : `content-type` reçoit `publication` ; `lieu` reçoit
  `saint-petersbourg` ; nouvelles facettes `element` (`eau`, `air`) et `annee`
  (2024 à 2026).
- 5 tests dans `test/taxonomy.test.js`.

## Exemples (`examples/<nom>/queries.json` et `pools/*.json`)

| Pool | Thème / sous-thème | Facettes | Ordre | Limite |
|---|---|---|---|---|
| `psychologie-2025` | psychologie | content-type=publication, annee=2025 | composite | 1000 |
| `creatures-eau` | illustration / creatures | element=eau | rarity | 300 |
| `creatures-air` | illustration / creatures | element=air | rarity | 300 |
| `spb-sociologie` | sociologie | lieu=saint-petersbourg | composite | 500 |
| `spb-insolite` | lieux / insolite | lieu=saint-petersbourg | rarity | 300 |

Requêtes multilingues écrites à la main ; elles visent encore le provider
`brave` (voir `../2026_10_30_sources-openrouter/notes.md`).

## Limites connues

- `annee` ne se lit que dans l'URL et le titre : une publication de 2025 sans
  année visible n'entre pas dans `psychologie-2025`.
- Une seule valeur par facette dans un pool : pas de pool « eau ou air ».
- `saint-petersbourg` peut capter St. Petersburg (Floride).
- La nouvelle valeur `publication` impose un `classify --all` sur un corpus
  existant.
- Non essayé sur un corpus réel.
