import { configDefaults, defineConfig } from 'vitest/config';

// `pnpm test` : fonctions pures uniquement, aucune base requise.
export default defineConfig({
  test: { name: 'unit', exclude: [...configDefaults.exclude, 'test/integration/**'] },
});
