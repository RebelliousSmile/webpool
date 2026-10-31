# Notices de tiers

webpool est publié sous licence MIT (voir `LICENSE`). Il s'appuie sur des
composants tiers, installés par `pnpm install` et non recopiés dans ce dépôt.
Ce fichier signale ceux dont la licence demande une mention.

## libvips (via sharp)

- **Composant** : libvips 8.18.7 et ses dépendances, sous forme de bibliothèques
  précompilées livrées par les paquets npm `@img/sharp-libvips-<plateforme>`
  (par exemple `@img/sharp-libvips-linux-x64` 1.3.4), dépendances facultatives
  de `sharp` (Apache-2.0), qui génère les vignettes (`src/media/thumbnail.js`).
- **Licence** : GNU Lesser General Public License, version 3 ou ultérieure
  (LGPL-3.0-or-later). Texte : <https://www.gnu.org/licenses/lgpl-3.0.html>.
- **Code source** : libvips, <https://github.com/libvips/libvips> ; scripts de
  compilation des binaires livrés, <https://github.com/lovell/sharp-libvips>.
  La liste et la licence de chaque bibliothèque incluse (glib, libheif,
  librsvg, pango, libexif… en LGPL-3.0 ; les autres sous licences permissives)
  figurent dans le `README.md` du paquet `@img/sharp-libvips-<plateforme>`
  installé.
- **Liaison** : webpool ne modifie pas libvips et ne l'inclut pas dans son code.
  `sharp` charge la bibliothèque partagée (`libvips-cpp.so`, `.dylib` ou `.dll`)
  dynamiquement à l'exécution. On peut la remplacer par une version modifiée ou
  compilée localement (libvips installée sur le système, détectée par `sharp`)
  sans toucher à webpool, comme le prévoit la LGPL.
