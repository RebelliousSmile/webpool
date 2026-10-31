// Fichiers du cache de médias : nom = empreinte du WebP produit. Module sans
// dépendance, partagé par le cache (thumbnail.js) et l'API qui sert les fichiers.
export const MEDIA_FILE_RE = /^[0-9a-f]{32}\.webp$/;

// Chemin public d'un fichier du cache, ou null.
export const mediaUrl = (file) => (file ? `/api/v1/media/${file}` : null);
