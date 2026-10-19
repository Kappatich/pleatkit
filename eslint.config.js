import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

const browserGlobals = Object.fromEntries(
  ['window', 'document', 'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'fetch', 'URL', 'localStorage', 'navigator', 'location', 'history', 'matchMedia', 'IntersectionObserver', 'ResizeObserver', 'HTMLElement', 'Event', 'CustomEvent', 'performance'].map((g) => [g, 'readonly']),
)

export default tseslint.config(
  // examples/* and evals/apps/* are standalone apps with their own lint config (evals/apps: vendored templates);
  // evals/references are reference solutions in an app's zone (like the e2e fixtures), compiled by the eval graders
  { ignores: ['**/dist/**', '**/node_modules/**', '**/playwright-report/**', '**/test-results/**', 'apps/*/e2e/fixtures/**', 'examples/**', 'evals/apps/**', 'evals/references/**', 'evals/.out/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Node scripts (and the evals' task/fixture generators, which run under Node)
    files: ['**/scripts/**/*.{js,mjs}', 'scripts/**/*.{js,mjs}', 'evals/**/*.mjs', 'docs/research/data/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', fetch: 'readonly', URL: 'readonly' } },
  },
  {
    // DECISIONS 41: the landing's scripts run in the browser; linted, with browser globals (unused names warn)
    files: ['site/**/*.js'],
    languageOptions: { globals: browserGlobals },
    rules: { '@typescript-eslint/no-unused-vars': 'warn' },
  },
  {
    // Playwright scripts: page.evaluate() callbacks run in the page
    files: ['scripts/gallery-shot.mjs'],
    languageOptions: { globals: { document: 'readonly', window: 'readonly' } },
  },
)
