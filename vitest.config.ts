import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/tests/**/*.test.ts', 'src/tests/**/*.test.tsx'],
    exclude: ['node_modules', 'src/tests/unit/db-migration.test.ts', 'src/tests/integration/phase2-change-set.test.ts', 'src/tests/integration/phase3-sync-drift.test.ts'],
  },
});
