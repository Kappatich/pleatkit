import { defineConfig, devices } from '@playwright/test'

const DATA_PORT = '8788'
const WEB_PORT = 4183

// Strictly headless: never open windows on the developer's screen. Runs against the production build.
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
    {
      command: 'tsx server/index.ts',
      env: { DATA_PORT },
      url: `http://localhost:${DATA_PORT}/api/health`,
      reuseExistingServer: false,
    },
    {
      command: `vite preview --port ${WEB_PORT} --strictPort`,
      env: { DATA_PORT },
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
    },
  ],
})
