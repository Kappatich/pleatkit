#!/usr/bin/env node
import { serve } from '@hono/node-server'
import { createStoreApp, openStore } from './app.js'

// MORPHKIT_STORE_DB: SQLite file (default .morphkit/store.db), or :memory:
// MORPHKIT_STORE_PORT: default 8790
// MORPHKIT_MODERATION: off (default) | review: agent edits apply at once but wait for an admin's review
const file = process.env.MORPHKIT_STORE_DB ?? '.morphkit/store.db'
const port = Number(process.env.MORPHKIT_STORE_PORT ?? 8790)
const { db, close } = openStore({ file })
const server = serve({ fetch: createStoreApp(db, { moderation: process.env.MORPHKIT_MODERATION === 'review' ? 'review' : 'off' }).fetch, port }, () => console.log(`morphkit store-server on http://localhost:${port} (${file})`))
const stop = () =>
  server.close(() => {
    close()
    process.exit(0)
  })
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
