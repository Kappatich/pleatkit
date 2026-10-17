#!/usr/bin/env node
import { serve } from '@hono/node-server'
import { createStoreApp, openStore } from './app.js'
import { authFromEnv } from './auth.js'
import { sweepAlive24h } from './ledger.js'

// MORPHKIT_STORE_DB: SQLite file (default .morphkit/store.db), or :memory:
// MORPHKIT_STORE_PORT: default 8790
// MORPHKIT_MODERATION: off (default) | review: agent edits apply at once but wait for an admin's review
// MORPHKIT_APP_ID / MORPHKIT_APP_KEY / MORPHKIT_JWT_SECRET (or MORPHKIT_APPS): credentials, required with NODE_ENV=production
// MORPHKIT_DEMO_HEADERS=0 turns the demo headers off in development too
// MORPHKIT_REGION (default local) and MORPHKIT_ENVIRONMENT (default production with NODE_ENV=production, else development): recorded on every row (F2)
let auth
try {
  auth = authFromEnv(process.env)
} catch (e) {
  console.error(`morphkit store-server: ${(e as Error).message}`)
  process.exit(1)
}
const file = process.env.MORPHKIT_STORE_DB ?? '.morphkit/store.db'
const port = Number(process.env.MORPHKIT_STORE_PORT ?? 8790)
const { db, close } = openStore({ file })
const region = process.env.MORPHKIT_REGION ?? 'local'
const environment = process.env.MORPHKIT_ENVIRONMENT ?? (auth.production ? 'production' : 'development')
const app = createStoreApp(db, { moderation: process.env.MORPHKIT_MODERATION === 'review' ? 'review' : 'off', auth, region, environment })
// F3: `edit.alive24h` for applied edits that are still in their user's version a day later (hourly, idempotent)
const sweep = () => {
  try {
    sweepAlive24h(db, { region, environment })
  } catch (e) {
    console.error(`morphkit store-server: alive24h sweep failed: ${(e as Error).message}`)
  }
}
sweep()
setInterval(sweep, 60 * 60 * 1000).unref()
const apps = Object.keys(auth.apps ?? {})
const server = serve({ fetch: app.fetch, port }, () =>
  console.log(
    `morphkit store-server on http://localhost:${port} (${file}; ${apps.length ? `credentials for ${apps.join(', ')}` : 'no credentials'}` +
      `${auth.demoHeaders ? ', demo headers ON (development only)' : ''})`,
  ),
)
const stop = () =>
  server.close(() => {
    close()
    process.exit(0)
  })
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
