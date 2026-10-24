import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_PORT = '8798'
const AGENT_PORT = '8799'
const STORE_PORT = '8800'
const WEB_PORT = 4183
const ports = { DATA_PORT, AGENT_PORT, STORE_PORT }
// One app runs the production auth path (V1 A1): `?app=e2e-secure&auth=token`. Its credentials are made up
// per run (set once here, inherited by the workers); every other test app uses the development headers.
export const SECURE_APP = 'e2e-secure'
process.env.PLEATKIT_E2E_APP_KEY ??= `mk_test_${randomBytes(24).toString('base64url')}`
process.env.PLEATKIT_E2E_JWT_SECRET ??= randomBytes(32).toString('base64url')
const secure = { appKey: process.env.PLEATKIT_E2E_APP_KEY, jwtSecret: process.env.PLEATKIT_E2E_JWT_SECRET }
// PLEATKIT_LIVE=1 runs the agent on the real Anthropic API (key from the environment) for live-anthropic.spec.ts.
const LIVE = process.env.PLEATKIT_LIVE === '1'
// PLEATKIT_VIDEO=1 records docs/demo.mp4 (demo-video.spec.ts): the scripted agent pauses before each answer.
const VIDEO = process.env.PLEATKIT_VIDEO === '1'
const liveKey = process.env.PLEATKIT_API_KEY ?? process.env.POLYMORPH_API_KEY ?? process.env.ANTHROPIC_API_KEY
const agentEnv: Record<string, string> = LIVE
  ? {
      PLEATKIT_PROVIDER: 'anthropic',
      ...(liveKey ? { PLEATKIT_API_KEY: liveKey } : {}),
      ...Object.fromEntries(
        ['PLEATKIT_MODEL', 'PLEATKIT_CLASSIFIER_MODEL', 'PLEATKIT_EFFORT', 'PLEATKIT_BASE_URL', 'PLEATKIT_FALLBACKS', 'ANTHROPIC_BASE_URL']
          .filter((k) => process.env[k])
          .map((k) => [k, process.env[k]!]),
      ),
    }
  : { PLEATKIT_PROVIDER: 'scripted', ...(VIDEO ? { PLEATKIT_SCRIPTED_DELAY_MS: '1100' } : {}) }

// Strictly headless: never open windows on the developer's screen. Runs against the production build,
// with the scripted model provider (no network, no key) and an in-memory store-server.
export default defineConfig({
  testDir: './e2e',
  timeout: LIVE ? 180_000 : VIDEO ? 120_000 : 60_000,
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
    {
      command: 'tsx server/index.ts',
      // the demo's "backend": mints user tokens for the secure app and knows its public key
      env: { ...ports, PLEATKIT_JWT_SECRET: secure.jwtSecret, PLEATKIT_APP_KEY: secure.appKey },
      url: `http://localhost:${DATA_PORT}/api/health`,
      reuseExistingServer: false,
    },
    {
      command: 'node ../../packages/agent/dist/cli.js',
      env: {
        ...ports,
        ...agentEnv,
        PLEATKIT_AGENT_PORT: AGENT_PORT,
        PLEATKIT_STORE_URL: `http://localhost:${STORE_PORT}`,
        PLEATKIT_FIXTURES: path.join(here, 'e2e', 'fixtures', 'agent'),
        // the static rules, readonly sources and core types come from the build, not from the browser (06 item 8)
        PLEATKIT_MANIFEST: path.join(here, 'dist', 'pleatkit.manifest.json'),
        PLEATKIT_APP_ID: SECURE_APP,
        PLEATKIT_APP_KEY: secure.appKey,
        PLEATKIT_JWT_SECRET: secure.jwtSecret,
      },
      url: `http://localhost:${AGENT_PORT}/agent/health`,
      reuseExistingServer: false,
    },
    {
      command: 'node ../../packages/store-server/dist/cli.js',
      env: { ...ports, PLEATKIT_STORE_PORT: STORE_PORT, PLEATKIT_STORE_DB: ':memory:', PLEATKIT_APPS: JSON.stringify({ [SECURE_APP]: secure }) },
      url: `http://localhost:${STORE_PORT}/health`,
      reuseExistingServer: false,
    },
    { command: `vite preview --port ${WEB_PORT} --strictPort`, env: ports, url: `http://localhost:${WEB_PORT}`, reuseExistingServer: false },
  ],
})
