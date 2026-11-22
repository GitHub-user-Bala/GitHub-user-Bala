import js from '@eslint/js';
import ts from 'typescript-eslint';
import globals from 'globals';

export default ts.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/playwright-report/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { files: ['scripts/*.mjs'], languageOptions: { globals: globals.node } },
  { files: ['apps/web/public/sw.js'], languageOptions: { globals: globals.serviceworker } },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
);
