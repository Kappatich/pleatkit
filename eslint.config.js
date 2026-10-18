import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

const browserGlobals = Object.fromEntries(
  ['window', 'document', 'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'fetch', 'URL', 'localStorage', 'navigator', 'location', 'history', 'matchMedia', 'IntersectionObserver', 'ResizeObserver', 'HTMLElement', 'Event', 'CustomEvent', 'performance'].map((g) => [g, 'readonly']),
)

export default tseslint.config(
  // examples/* are standalone apps with their own lint config; evals/references are reference solutions in the
  // demo app's zone (like the e2e fixtures), compiled by the eval graders, not by this config
  { ignores: ['**/dist/**', '**/node_modules/**', '**/playwright-report/**', '**/test-results/**', 'apps/*/e2e/fixtures/**', 'examples/**', 'evals/references/**', 'evals/.out/**'] },
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
    // Node scripts
    files: ['**/scripts/**/*.{js,mjs}', 'scripts/**/*.{js,mjs}'],
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
