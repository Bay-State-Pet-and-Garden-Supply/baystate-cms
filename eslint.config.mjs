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
  // ADR-0030 (Agent Lab decommission): non-PI production code must not import
  // deleted PI paths. The relocated onboarding modules live in
  // src/onboarding/image-verification, imported-result-gate, and the slim db
  // repos. Remaining ignores cover only the relocated-code tests that still
  // reference the kept pi_* tables by name.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/tests/unit/pi-reuse-policies.test.ts',
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
