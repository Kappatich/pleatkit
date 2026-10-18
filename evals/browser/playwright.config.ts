import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

/**
 * The browser grader of the eval harness, on ports of its own so it can run next to `pnpm dev` or `pnpm e2e`.
 * Strictly headless. `EVAL_APP` picks the app:
 * - `demo-crm` (default): the demo's production build with its data server, agent server (scripted provider: it
 *   only compiles and signs here, the answers come from the eval run) and an in-memory store-server;
 * - a foreign app (`evals/apps/<app>`, DECISIONS 73.1): its production build under `vite preview`, the same agent
 *   server with the app's build manifest, and an in-memory store-server. These apps keep their data in code.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const APP = process.env.EVAL_APP ?? 'demo-crm'
const demo = path.resolve(here, '../../apps/demo-crm')
const appDir = APP === 'demo-crm' ? demo : path.resolve(here, '../apps', APP)
const repo = path.resolve(here, '../..')
const DATA_PORT = process.env.EVAL_DATA_PORT ?? '8898'
const AGENT_PORT = process.env.EVAL_AGENT_PORT ?? '8899'
const STORE_PORT = process.env.EVAL_STORE_PORT ?? '8900'
const WEB_PORT = Number(process.env.EVAL_WEB_PORT ?? 4283)
const ports = { DATA_PORT, AGENT_PORT, STORE_PORT }
// the foreign apps' vite.config reads these for its proxies (install.md step 3, ports moved)
const appPorts = { PLEATKIT_AGENT_PORT: AGENT_PORT, PLEATKIT_STORE_PORT: STORE_PORT }

const agentServer = {
  command: `node ${JSON.stringify(path.join(repo, 'packages/agent/dist/cli.js'))}`,
  cwd: appDir,
  env: {
    ...ports,
    PLEATKIT_PROVIDER: 'scripted',
    PLEATKIT_AGENT_PORT: AGENT_PORT,
    PLEATKIT_STORE_URL: `http://localhost:${STORE_PORT}`,
    PLEATKIT_FIXTURES: path.join(demo, 'e2e', 'fixtures', 'agent'),
    PLEATKIT_MANIFEST: path.join(appDir, 'dist', 'pleatkit.manifest.json'),
  },
  url: `http://localhost:${AGENT_PORT}/agent/health`,
  reuseExistingServer: false,
  // the agent's compile log lines go into the grader's output (crm-07, DECISIONS 70.8)
  stdout: 'pipe' as const,
}
const storeServer = {
  command: `node ${JSON.stringify(path.join(repo, 'packages/store-server/dist/cli.js'))}`,
  cwd: appDir,
  env: { ...ports, PLEATKIT_STORE_PORT: STORE_PORT, PLEATKIT_STORE_DB: ':memory:' },
  url: `http://localhost:${STORE_PORT}/health`,
  reuseExistingServer: false,
}

const webServer =
  APP === 'demo-crm'
    ? [
        { command: 'pnpm exec tsx server/index.ts', cwd: demo, env: ports, url: `http://localhost:${DATA_PORT}/api/health`, reuseExistingServer: false },
        agentServer,
        storeServer,
        { command: `pnpm exec vite preview --port ${WEB_PORT} --strictPort`, cwd: demo, env: ports, url: `http://localhost:${WEB_PORT}`, reuseExistingServer: false },
      ]
    : [
        agentServer,
        storeServer,
        // the app's own Vite (pnpm or npm install alike)
        { command: `node node_modules/vite/bin/vite.js preview --port ${WEB_PORT} --strictPort`, cwd: appDir, env: appPorts, url: `http://localhost:${WEB_PORT}`, reuseExistingServer: false },
      ]

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
  webServer,
})
