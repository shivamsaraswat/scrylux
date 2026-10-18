import { builtinModules } from 'node:module';
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/test/contract/fixtures/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The browser app (Phase 1 Milestone 6). Record text is rendered as text (FR-017), and the access
    // token never touches browser storage (FR-004).
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Render record text as text (FR-017).',
        },
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/**/*.test.{ts,tsx}', 'apps/web/src/test-setup.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['localStorage', 'sessionStorage', 'indexedDB'].map((name) => ({
          name,
          message: 'The access token never touches browser storage (FR-004).',
        })),
      ],
    },
  },
  {
    // Node-side files of the web package: tool configs and the Playwright suite.
    files: ['apps/web/*.config.ts', 'apps/web/e2e/**/*.ts', 'apps/web/test/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // Repository tooling (Phase 1 Milestone 7): the license check.
    files: ['scripts/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // @scrylux/core must run in the browser too (spec FR-036), so it cannot reach for Node built-ins.
    // Together with the Node-types-free `tsc` pass over src/ (packages/core/tsconfig.build.json),
    // this is checked on every PR by the existing typecheck and lint jobs.
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: ['node:*'], message: '@scrylux/core must not depend on Node.js APIs.' }],
          paths: builtinModules.map((name) => ({
            name,
            message: '@scrylux/core must not depend on Node.js APIs.',
          })),
        },
      ],
    },
  },
);
