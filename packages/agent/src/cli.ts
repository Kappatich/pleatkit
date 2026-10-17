#!/usr/bin/env node
import { serve } from '@hono/node-server'
import { configFromEnv } from './config.js'
import { createAgentApp } from './server.js'

let config: ReturnType<typeof configFromEnv>
try {
  config = configFromEnv()
} catch (e) {
  console.error(`morphkit agent: ${(e as Error).message}`)
  process.exit(1)
}
const app = createAgentApp({ provider: config.provider, limits: config.limits, storeUrl: config.storeUrl, corsOrigin: config.corsOrigin, auth: config.auth, plan: config.plan, manifest: config.manifest, typecheck: config.typecheck, alerts: config.alerts })
const server = serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(
    `morphkit agent on http://localhost:${config.port}/agent (provider ${config.provider.name}, model ${config.provider.model}` +
      `${config.storeUrl ? `, logging to ${config.storeUrl}` : ''}${config.manifest ? ', server manifest' : ', context from the browser (development)'}${config.auth.credentials ? `, app ${config.auth.credentials.appId} with credentials` : ', no credentials (development)'})`,
  )
})
const stop = () => server.close(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
