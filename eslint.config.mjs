import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.bun,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  // ADR-0030 (Agent Lab decommission): non-PI production code must not
  // import src/product-intelligence/** — the relocated onboarding modules
  // (src/onboarding/image-verification, imported-result-gate, db repos) are
  // the only sanctioned dependencies. PI's own code and its dedicated tests
  // are exempt; the Agent Lab client surface is deleted in Phase 2.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/product-intelligence/**',
      'src/client/agent-lab/**',
      'src/client/product-intelligence-api.ts',
      'src/client/hooks/useProductIntelligenceEvents.ts',
      'src/client/App.tsx',
      'src/server/routes/product-intelligence-routes.ts',
      'src/tests/unit/product-intelligence*',
      'src/tests/unit/pi-*',
      'src/tests/unit/specialist-workflow-repo.test.ts',
      'src/tests/unit/specialist-workflow-import.test.ts',
      'src/tests/unit/profile-engineer-workflow-repo.test.ts',
      'src/tests/unit/evaluation-orchestrator.test.ts',
      'src/tests/unit/compiled-prompt-builder.test.ts',
      'src/tests/unit/e03s01-*.test.ts',
      'src/tests/unit/product-intelligence/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/product-intelligence/*', '**/product-intelligence/**'],
              message: 'ADR-0030: Product Intelligence is being decommissioned — use the relocated onboarding modules instead.',
            },
          ],
        },
      ],
    },
  },
);
