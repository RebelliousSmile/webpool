import { defineConfig } from 'vitest/config';

// `pnpm test:integration` : couches DB contre le PostgreSQL local (docker compose).
// Un schéma jetable par fichier de test isole la suite des données réelles.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.js'],
    setupFiles: ['test/integration/setup.js'],
    fileParallelism: false,
    testTimeout: 15000,
  },
});
