import os from 'node:os'
import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'

// The public demo server (server/public, docs/demo-hosting.md) in both modes, headless. SCRIPTED on one port; LIVE
// with the fake model provider (no key, made-up but priced usage) and a tiny budget on another, so the cap is
// reached within the suite. Each run gets fresh state and data folders (inherited by the workers).
process.env.DEMO_E2E_RUN ??= String(Date.now())
export const DEMO_E2E_DIR = path.join(os.tmpdir(), 'pleatkit-demo-e2e', process.env.DEMO_E2E_RUN)
export const PORTS = { scripted: 4191, live: 4192 } as const

const server = (mode: 'scripted' | 'live', env: Record<string, string>) => ({
  command: process.env.DEMO_SERVER_COMMAND ?? 'tsx server/public/main.ts',
  env: {
    DEMO_MODE: mode,
    DEMO_PORT: String(PORTS[mode]),
    DEMO_STATE_DIR: path.join(DEMO_E2E_DIR, mode, 'state'),
    DEMO_DATA_DIR: path.join(DEMO_E2E_DIR, mode, 'data'),
    DEMO_SCRIPTED_DELAY_MS: '100',
    // many visitors from one address in a few minutes
    DEMO_RATE_SCALE: '20',
    ...env,
  },
  url: `http://127.0.0.1:${PORTS[mode]}/demo/api/health`,
  reuseExistingServer: false,
})

export default defineConfig({
  testDir: './e2e-demo',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { headless: true, trace: 'retain-on-failure', viewport: { width: 1400, height: 900 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], headless: true, viewport: { width: 1400, height: 900 } } }],
  webServer: [
    server('scripted', {}),
    server('live', {
      DEMO_LIVE_PROVIDER: 'fake',
      // a run costs about $0.102 (classifier $0.002 + two turns of $0.05); a run starts only while
      // spent + $0.20 still fits under $0.50, so the third run is the last one of the day
      DEMO_FAKE_COST_USD: '0.1',
      DEMO_LIVE_MAX_USD_PER_REQUEST: '0.2',
      DEMO_DAILY_USD: '0.5',
      DEMO_DAILY_LIVE_REQUESTS: '10',
      DEMO_VISITOR_LIVE_REQUESTS: '2',
      DEMO_VISITOR_IP_FACTOR: '10',
    }),
  ],
})
