import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_PORT = '8798'
const AGENT_PORT = '8799'
const STORE_PORT = '8800'
const WEB_PORT = 4183
const ports = { DATA_PORT, AGENT_PORT, STORE_PORT }

// Strictly headless: never open windows on the developer's screen. Runs against the production build,
// with the scripted model provider (no network, no key) and an in-memory store-server.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    headless: true,
    trace: 'retain-on-failure',
    viewport: { width: 1400, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], headless: true, viewport: { width: 1400, height: 900 } } }],
  webServer: [
    { command: 'tsx server/index.ts', env: ports, url: `http://localhost:${DATA_PORT}/api/health`, reuseExistingServer: false },
    {
      command: 'node ../../packages/agent/dist/cli.js',
      env: {
        ...ports,
        MORPHKIT_PROVIDER: 'scripted',
        MORPHKIT_AGENT_PORT: AGENT_PORT,
        MORPHKIT_STORE_URL: `http://localhost:${STORE_PORT}`,
        MORPHKIT_FIXTURES: path.join(here, 'e2e', 'fixtures', 'agent'),
      },
      url: `http://localhost:${AGENT_PORT}/agent/health`,
      reuseExistingServer: false,
    },
    {
      command: 'node ../../packages/store-server/dist/cli.js',
      env: { ...ports, MORPHKIT_STORE_PORT: STORE_PORT, MORPHKIT_STORE_DB: ':memory:' },
      url: `http://localhost:${STORE_PORT}/health`,
      reuseExistingServer: false,
    },
    { command: `vite preview --port ${WEB_PORT} --strictPort`, env: ports, url: `http://localhost:${WEB_PORT}`, reuseExistingServer: false },
  ],
})
