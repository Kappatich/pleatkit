#!/usr/bin/env node
import { serve } from '@hono/node-server'
import { configFromEnv } from './config.js'
import { createAgentApp } from './server.js'

const config = configFromEnv()
const app = createAgentApp({ provider: config.provider, limits: config.limits, storeUrl: config.storeUrl, corsOrigin: config.corsOrigin })
const server = serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(
    `morphkit agent on http://localhost:${config.port}/agent (provider ${config.provider.name}, model ${config.provider.model}` +
      `${config.storeUrl ? `, logging to ${config.storeUrl}` : ''})`,
  )
})
const stop = () => server.close(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
