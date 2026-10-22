#!/usr/bin/env node
import { serve } from '@hono/node-server'
import { configFromEnv } from './config.js'
import { loadAgentExtensions } from './extensions-loader.js'
import { createAgentApp } from './server.js'

let config: ReturnType<typeof configFromEnv>
let loaded: Awaited<ReturnType<typeof loadAgentExtensions>>
try {
  config = configFromEnv()
  // DECISIONS 89: PLEATKIT_AGENT_EXTENSIONS, or @pleatkit/agent-cloud when the deployment depends on it
  loaded = await loadAgentExtensions(process.env)
} catch (e) {
  console.error(`pleatkit agent: ${(e as Error).message}`)
  process.exit(1)
}
const app = createAgentApp({ provider: config.provider, limits: config.limits, storeUrl: config.storeUrl, corsOrigin: config.corsOrigin, auth: config.auth, plan: config.plan, manifest: config.manifest, typecheck: config.typecheck, warmTypecheckApps: config.warmTypecheckApps, commitTypecheck: config.commitTypecheck, classifierMode: config.classifierMode, tail: config.tail, alerts: config.alerts, extensions: loaded.extensions, modelConcurrency: config.modelConcurrency, rateLimitRetries: config.rateLimitRetries })
const server = serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(
    `pleatkit agent on http://localhost:${config.port}/agent (provider ${config.provider.name}, model ${config.provider.model}` +
      `${config.storeUrl ? `, logging to ${config.storeUrl}` : ''}${config.manifest ? ', server manifest' : ', context from the browser (development)'}${config.typecheck ? ', type check on' : ''}${config.auth.credentials ? `, app ${config.auth.credentials.appId} with credentials` : ', no credentials (development)'}; ${loaded.modules.length ? `extensions ${loaded.modules.join(', ')}` : 'open server, no extensions'})`,
  )
})
const stop = () => server.close(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
