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
    exclude: [
      'node_modules',
      'src/tests/unit/db-migration.test.ts',
      'src/tests/unit/catalog-health.test.ts',
      'src/tests/integration/phase2-change-set.test.ts',
      'src/tests/integration/phase3-sync-drift.test.ts',
      'src/tests/unit/onboarding-repos.test.ts',
      'src/tests/unit/draft-promoter.test.ts',
      'src/tests/unit/onboarding-duplicate-skip.test.ts',
      'src/tests/unit/extractor-profiles.test.ts',
      'src/tests/unit/extraction-remedies.test.ts',
      'src/tests/unit/classification-pipeline.test.ts',
      'src/tests/unit/source-discovery.test.ts',
      'src/tests/unit/profile-generation-repo.test.ts',
      'src/tests/unit/profile-promoter.test.ts',
      'src/tests/unit/serper-cache-integration.test.ts',
      'src/tests/unit/serper-cache-repo.test.ts',
      'src/tests/unit/sitemap-cache-repo.test.ts',
      'src/tests/unit/sitemap-fetcher.test.ts',
      'src/tests/unit/sitemap-matcher.test.ts',
      'src/tests/unit/profile-generation-revision-repo.test.ts',
      'src/tests/unit/profile-generation-field-decision-repo.test.ts',
      'src/tests/unit/llm-task-config-repo.test.ts',
      'src/tests/unit/llm-client-task-routing.test.ts',
      'src/tests/unit/profile-governance-service.test.ts',
      'src/tests/unit/domain-diagnostics-service.test.ts'
    ],
  },
});
