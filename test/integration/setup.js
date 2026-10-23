import { schemaUrl } from './helpers.js';

// Exécuté avant chaque fichier de test, donc avant l'import de src/config.js.
process.env.DATABASE_URL = schemaUrl();
