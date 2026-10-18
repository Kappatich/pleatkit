#!/usr/bin/env node
import { serve } from '@hono/node-server'
import { createStoreApp, openStore } from './app.js'
import { authFromEnv } from './auth.js'
import { sweepAlive24h } from './ledger.js'
import { applyRetention, DEFAULT_RETENTION, type RetentionPolicy } from './facts.js'
import { pleatkitEnv } from '@pleatkit/runtime/env'

pleatkitEnv(process.env)

// PLEATKIT_STORE_DB: SQLite file (default .pleatkit/store.db), or :memory:
// PLEATKIT_STORE_PORT: default 8790
// PLEATKIT_MODERATION: off (default) | review: agent edits apply at once but wait for an admin's review
// PLEATKIT_APP_ID / PLEATKIT_APP_KEY / PLEATKIT_JWT_SECRET (or PLEATKIT_APPS): credentials, required with NODE_ENV=production
// PLEATKIT_DEMO_HEADERS=0 turns the demo headers off in development too
// PLEATKIT_STORE_BODY_LIMIT: largest request body in bytes (default 4 MiB; larger bodies get 413)
// PLEATKIT_LEARNING: off (default) | aggregate | contribute, the default of each app's learning flag (DECISIONS 44)
// PLEATKIT_RETENTION: JSON {"textDays": 90, "logDays": 30, "factsDays": 548}, applied hourly
// PLEATKIT_REGION (default local) and PLEATKIT_ENVIRONMENT (default production with NODE_ENV=production, else development): recorded on every row (F2)
let auth
try {
  auth = authFromEnv(process.env)
} catch (e) {
  console.error(`pleatkit store-server: ${(e as Error).message}`)
  process.exit(1)
}
const file = process.env.PLEATKIT_STORE_DB ?? '.pleatkit/store.db'
const port = Number(process.env.PLEATKIT_STORE_PORT ?? 8790)
const { db, close } = openStore({ file })
const region = process.env.PLEATKIT_REGION ?? 'local'
const environment = process.env.PLEATKIT_ENVIRONMENT ?? (auth.production ? 'production' : 'development')
const bodyLimitBytes = Number(process.env.PLEATKIT_STORE_BODY_LIMIT) || undefined
const learning = (['off', 'aggregate', 'contribute'] as const).find((m) => m === process.env.PLEATKIT_LEARNING) ?? 'off'
const retention = { ...DEFAULT_RETENTION, ...(process.env.PLEATKIT_RETENTION ? (JSON.parse(process.env.PLEATKIT_RETENTION) as Partial<RetentionPolicy>) : {}) }
const app = createStoreApp(db, { moderation: process.env.PLEATKIT_MODERATION === 'review' ? 'review' : 'off', auth, region, environment, learning, ...(bodyLimitBytes ? { bodyLimitBytes } : {}) })
// F3: `edit.alive24h` for applied edits that are still in their user's version a day later (hourly, idempotent)
const sweep = () => {
  try {
    sweepAlive24h(db, { region, environment })
    applyRetention(db, Date.now(), retention)
  } catch (e) {
    console.error(`pleatkit store-server: alive24h sweep failed: ${(e as Error).message}`)
  }
}
sweep()
setInterval(sweep, 60 * 60 * 1000).unref()
const apps = Object.keys(auth.apps ?? {})
const server = serve({ fetch: app.fetch, port }, () =>
  console.log(
    `pleatkit store-server on http://localhost:${port} (${file}; ${apps.length ? `credentials for ${apps.join(', ')}` : 'no credentials'}` +
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
