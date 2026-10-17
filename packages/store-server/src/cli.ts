#!/usr/bin/env node
import { serve } from '@hono/node-server'
import { createStoreApp, openStore } from './app.js'
import { authFromEnv } from './auth.js'

// MORPHKIT_STORE_DB: SQLite file (default .morphkit/store.db), or :memory:
// MORPHKIT_STORE_PORT: default 8790
// MORPHKIT_MODERATION: off (default) | review: agent edits apply at once but wait for an admin's review
// MORPHKIT_APP_ID / MORPHKIT_APP_KEY / MORPHKIT_JWT_SECRET (or MORPHKIT_APPS): credentials, required with NODE_ENV=production
// MORPHKIT_DEMO_HEADERS=0 turns the demo headers off in development too
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
const app = createStoreApp(db, { moderation: process.env.MORPHKIT_MODERATION === 'review' ? 'review' : 'off', auth })
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
