#!/usr/bin/env node
import { serve } from '@hono/node-server'
import { createStoreApp, openStore } from './app.js'
import { authFromEnv } from './auth.js'
import { loadExtensions } from './extensions-loader.js'
import { DEFAULT_RETENTION, runMaintenance, type RetentionPolicy } from './retention.js'
import { MAX_MINUTES_PER_EDIT, parseMinutesPerEdit } from './report.js'

// PLEATKIT_STORE_DB: SQLite file (default .pleatkit/store.db), or :memory:
// PLEATKIT_STORE_PORT: default 8790
// PLEATKIT_MODERATION: off (default) | review: agent edits apply at once but wait for an admin's review
// PLEATKIT_APP_ID / PLEATKIT_APP_KEY / PLEATKIT_JWT_SECRET (or PLEATKIT_APPS): credentials, required with NODE_ENV=production
// PLEATKIT_DEMO_HEADERS=0 turns the demo headers off in development too
// PLEATKIT_STORE_BODY_LIMIT: largest request body in bytes (default 4 MiB; larger bodies get 413)
// PLEATKIT_RETENTION: JSON {"textDays": 90, "logDays": 30}, applied hourly (the cloud module reads "factsDays" too)
// PLEATKIT_STORE_EXTENSIONS: none | <module>[,<module>]; unset: @pleatkit/store-cloud when this deployment's package.json depends on it (DECISIONS 70.1)
// PLEATKIT_REPORT_MINUTES_PER_EDIT: minutes one applied edit saves a developer, for the report's dev_hours_saved (default 20)
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
const retention = { ...DEFAULT_RETENTION, ...(process.env.PLEATKIT_RETENTION ? (JSON.parse(process.env.PLEATKIT_RETENTION) as Partial<RetentionPolicy>) : {}) }
let loaded
try {
  loaded = await loadExtensions(process.env)
} catch (e) {
  console.error(`pleatkit store-server: ${(e as Error).message}`)
  process.exit(1)
}
const { extensions, modules } = loaded
const reportMinutesPerEdit = parseMinutesPerEdit(process.env.PLEATKIT_REPORT_MINUTES_PER_EDIT)
if (process.env.PLEATKIT_REPORT_MINUTES_PER_EDIT && reportMinutesPerEdit === null) {
  console.error(`pleatkit store-server: PLEATKIT_REPORT_MINUTES_PER_EDIT must be a number above 0 and at most ${MAX_MINUTES_PER_EDIT}`)
  process.exit(1)
}
const app = createStoreApp(db, {
  moderation: process.env.PLEATKIT_MODERATION === 'review' ? 'review' : 'off',
  auth,
  region,
  environment,
  extensions,
  ...(bodyLimitBytes ? { bodyLimitBytes } : {}),
  ...(reportMinutesPerEdit !== null ? { reportMinutesPerEdit } : {}),
})
// F3 `edit.alive24h`, the retention job and the extensions' jobs (hourly, idempotent)
const sweep = () => {
  try {
    runMaintenance(db, { region, environment, retention, extensions })
  } catch (e) {
    console.error(`pleatkit store-server: maintenance failed: ${(e as Error).message}`)
  }
}
sweep()
setInterval(sweep, 60 * 60 * 1000).unref()
const apps = Object.keys(auth.apps ?? {})
const server = serve({ fetch: app.fetch, port }, () =>
  console.log(
    `pleatkit store-server on http://localhost:${port} (${modules.length ? `open core + ${modules.join(', ')}` : 'open core'}; ${file}; ${apps.length ? `credentials for ${apps.join(', ')}` : 'no credentials'}` +
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
