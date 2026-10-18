import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

/**
 * The browser grader of the eval harness: the demo app's production build with its data server, agent server
 * (scripted provider: it only compiles and signs here, the answers come from the eval run) and an in-memory
 * store-server, on ports of their own so it can run next to `pnpm dev` or `pnpm e2e`. Strictly headless.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const demo = path.resolve(here, '../../apps/demo-crm')
const DATA_PORT = process.env.EVAL_DATA_PORT ?? '8898'
const AGENT_PORT = process.env.EVAL_AGENT_PORT ?? '8899'
const STORE_PORT = process.env.EVAL_STORE_PORT ?? '8900'
const WEB_PORT = Number(process.env.EVAL_WEB_PORT ?? 4283)
const ports = { DATA_PORT, AGENT_PORT, STORE_PORT }

export default defineConfig({
  testDir: here,
  testMatch: /invariants\.spec\.ts$/,
  outputDir: path.resolve(here, '../.out/browser/test-results'),
  timeout: 60_000,
  // a failed invariant waits this long before it is recorded
  expect: { timeout: 2_500 },
  fullyParallel: false,
  workers: 1,
  reporter: [['line']],
  use: { baseURL: `http://localhost:${WEB_PORT}`, headless: true, viewport: { width: 1400, height: 900 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], headless: true, viewport: { width: 1400, height: 900 } } }],
  webServer: [
    { command: 'pnpm exec tsx server/index.ts', cwd: demo, env: ports, url: `http://localhost:${DATA_PORT}/api/health`, reuseExistingServer: false },
    {
      command: 'node ../../packages/agent/dist/cli.js',
      cwd: demo,
      env: {
        ...ports,
        PLEATKIT_PROVIDER: 'scripted',
        PLEATKIT_AGENT_PORT: AGENT_PORT,
        PLEATKIT_STORE_URL: `http://localhost:${STORE_PORT}`,
        PLEATKIT_FIXTURES: path.join(demo, 'e2e', 'fixtures', 'agent'),
        PLEATKIT_MANIFEST: path.join(demo, 'dist', 'pleatkit.manifest.json'),
      },
      url: `http://localhost:${AGENT_PORT}/agent/health`,
      reuseExistingServer: false,
      // the agent's compile log lines go into the grader's output (crm-07, DECISIONS 70.8)
      stdout: 'pipe',
    },
    {
      command: 'node ../../packages/store-server/dist/cli.js',
      cwd: demo,
      env: { ...ports, PLEATKIT_STORE_PORT: STORE_PORT, PLEATKIT_STORE_DB: ':memory:' },
      url: `http://localhost:${STORE_PORT}/health`,
      reuseExistingServer: false,
    },
    { command: `pnpm exec vite preview --port ${WEB_PORT} --strictPort`, cwd: demo, env: ports, url: `http://localhost:${WEB_PORT}`, reuseExistingServer: false },
  ],
})
