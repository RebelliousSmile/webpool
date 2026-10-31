import { defineConfig } from 'vitest/config';

// `pnpm test:coverage` : suites unitaire et d'intégration réunies, une seule
// mesure de couverture. Requiert PostgreSQL (WEBPOOL_IT_REQUIRED conseillé).
export default defineConfig({
  test: {
    projects: ['./vitest.config.js', './vitest.integration.config.js'],
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      // bin/webpool.js est exercé par test/cli.test.js dans un processus
      // séparé, que la mesure v8 ne suit pas : il n'est pas compté.
      include: ['src/**/*.js'],
      reporter: ['text-summary', 'text', 'html'],
      // planchers juste sous la mesure du 2026-10-30 : une baisse fait échouer la CI
      thresholds: { statements: 95, branches: 90, functions: 93, lines: 97 },
    },
  },
});
