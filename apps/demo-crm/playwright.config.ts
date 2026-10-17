import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_PORT = '8798'
const AGENT_PORT = '8799'
const STORE_PORT = '8800'
const WEB_PORT = 4183
const ports = { DATA_PORT, AGENT_PORT, STORE_PORT }
// MORPHKIT_LIVE=1 runs the agent on the real Anthropic API (key from the environment) for live-anthropic.spec.ts.
const LIVE = process.env.MORPHKIT_LIVE === '1'
const liveKey = process.env.MORPHKIT_API_KEY ?? process.env.POLYMORPH_API_KEY ?? process.env.ANTHROPIC_API_KEY
const agentEnv: Record<string, string> = LIVE
  ? {
      MORPHKIT_PROVIDER: 'anthropic',
      ...(liveKey ? { MORPHKIT_API_KEY: liveKey } : {}),
      ...Object.fromEntries(
        ['MORPHKIT_MODEL', 'MORPHKIT_CLASSIFIER_MODEL', 'MORPHKIT_EFFORT', 'MORPHKIT_BASE_URL', 'MORPHKIT_FALLBACKS', 'ANTHROPIC_BASE_URL']
          .filter((k) => process.env[k])
          .map((k) => [k, process.env[k]!]),
      ),
    }
  : { MORPHKIT_PROVIDER: 'scripted' }

// Strictly headless: never open windows on the developer's screen. Runs against the production build,
// with the scripted model provider (no network, no key) and an in-memory store-server.
export default defineConfig({
  testDir: './e2e',
  timeout: LIVE ? 180_000 : 60_000,
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
        ...agentEnv,
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
