import { normalizeResults } from './file.js';

// Provider virtuel des listes de liens soumises par les membres d'une
// communauté (search_request.links) : les « résultats » sont la liste
// elle-même, rangée dans l'ordre de soumission. Aucun appel réseau, aucun
// fichier : `input` est le tableau validé, jamais un chemin.
export async function search({ input }) {
  if (!Array.isArray(input)) throw new Error('Provider list : liste de liens attendue');
  return normalizeResults(input);
}
