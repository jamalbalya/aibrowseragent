import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        // A union is exhaustively handled when every member has a case, or
        // when a default clause covers the remainder. Requiring an explicit
        // `undefined` case on a `string | undefined` adds noise, not safety.
        { considerDefaultExhaustiveForUnions: true, allowDefaultCaseForExhaustiveSwitch: true },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // Production code must route through the structured logger (src/logging).
      'no-console': 'error',
      'no-restricted-globals': [
        'error',
        { name: 'eval', message: 'Dynamic code execution is prohibited in this extension.' },
      ],
    },
  },

  {
    files: ['src/sidepanel/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },

  {
    files: ['tests/**/*.ts', 'tests/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },

  {
    // Plain JS config and script files have no TypeScript project, so the
    // type-aware rules must be switched off for them. `rules` is merged
    // explicitly: an object spread would replace the disabled-rule set.
    files: ['scripts/**/*.mjs', '*.config.js', 'eslint.config.js', 'prettier.config.js'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  prettier,
);
