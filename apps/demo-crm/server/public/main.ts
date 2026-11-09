// The public demo server (demo.pleatkit.com, docs/demo-hosting.md): one Node process with the demo CRM, its data
// API, the agent server and one store-server per visitor, behind nginx. `pnpm demo:public` runs it from source;
// scripts/deploy-demo.sh bundles it (server.mjs) and runs it under systemd.
import fs from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { createAgentApp, createTypechecker, loadFixtures, loadManifest, providerFromEnv, ScriptedProvider, type ModelProvider } from './agent-api.js'
import { DEMO_REQUESTS } from '../../src/core/demo-requests.js'
import { Budget } from './budget.js'
import { demoConfigFromEnv } from './config.js'
import { DataLog } from './datalog.js'
import { createGateway } from './gateway.js'
import { RateLimiter } from './rate-limit.js'
import { demoRunner, demoTexts, FakeLiveProvider } from './runner.js'
import { Visitors } from './visitors.js'

const log = (line: string) => console.log(line)
const config = demoConfigFromEnv()

const manifestFile = path.join(config.webDir, 'pleatkit.manifest.json')
if (!fs.existsSync(manifestFile)) {
  console.error(`[demo] no ${manifestFile}: build the app first (pnpm --filter @pleatkit/demo-crm build)`)
  process.exit(1)
}

// the six requests, answered from their recorded fixtures only
const wanted = new Set(DEMO_REQUESTS.map((r) => r.fixture))
const fixtures = loadFixtures(config.fixturesDir).filter((f) => wanted.has(f.name))
if (fixtures.length !== wanted.size) {
  console.error(`[demo] ${config.fixturesDir} has ${fixtures.length} of the ${wanted.size} fixtures of the demo requests`)
  process.exit(1)
}
const scripted = new ScriptedProvider(fixtures, { delayMs: config.scriptedDelayMs })

let live: ModelProvider | null = null
if (config.mode === 'live') {
  if (config.liveProvider === 'fake') live = new FakeLiveProvider(config.fixturesDir, Number(process.env.DEMO_FAKE_COST_USD ?? 0.12), config.scriptedDelayMs)
  else {
    const hasKey = Boolean(process.env.PLEATKIT_API_KEY ?? process.env.ANTHROPIC_API_KEY)
    if (!hasKey) {
      log('[demo] DEMO_MODE=live but no PLEATKIT_API_KEY / ANTHROPIC_API_KEY in the environment: running SCRIPTED')
      config.mode = 'scripted'
    } else {
      // the key is read here and nowhere else; it is never logged
      live = providerFromEnv({ ...process.env, PLEATKIT_PROVIDER: 'anthropic', PLEATKIT_CLASSIFIER_ENSEMBLE: 'off' })
    }
  }
}

fs.mkdirSync(config.dataDir, { recursive: true })
const visitors = new Visitors({ stateDir: config.stateDir, ttlMs: config.visitorTtlMs, maxVisitors: config.maxVisitors })
const budget = new Budget(config, log)
const datalog = new DataLog(config.dataDir, config.retentionDays, log)
const limiter = new RateLimiter(Number(process.env.DEMO_RATE_SCALE ?? 1) || 1)

/** The agent's calls to "store-server" go to the visitor's own store in this process, chosen by the app id. */
const storeFetch: typeof fetch = async (input, init) => {
  const req = new Request(input, init)
  const v = visitors.byAppId(req.headers.get('x-pleatkit-app'))
  if (!v) return new Response(JSON.stringify({ error: 'no such visitor' }), { status: 404, headers: { 'content-type': 'application/json' } })
  return visitors.storeOf(v).fetch(req)
}

const typecheckOff = ['0', 'off', 'false'].includes((process.env.DEMO_TYPECHECK ?? '').trim().toLowerCase())
const typecheckRoot = path.dirname(config.webDir)
const agent = createAgentApp({
  runner: demoRunner({ scripted, live, perRequestUsd: config.budget.perRequestUsd, texts: demoTexts(config.contactEmail) }),
  storeUrl: 'http://store.internal',
  fetch: storeFetch,
  // one release for every visitor: the static rules, readonly sources and types come from the build
  manifest: () => loadManifest(manifestFile),
  typecheck: typecheckOff ? null : createTypechecker({ root: fs.existsSync(path.join(typecheckRoot, 'node_modules')) ? typecheckRoot : null }),
  // the demo's budget replaces the plan quotas (each visitor is an app of its own, so app quotas would not cap anything)
  quotas: false,
  // the classifier answers first, so an off-topic request never starts the big model (the off-topic guard)
  classifierMode: 'sequential',
  modelConcurrency: config.budget.concurrency + 4,
  bodyLimitBytes: 2 * 1024 * 1024,
  log,
})

const gateway = createGateway({ config, visitors, budget, datalog, limiter, agent, log })

const sweep = () => {
  try {
    const gone = visitors.sweep()
    const pruned = datalog.prune()
    limiter.prune()
    if (gone || pruned) log(`[demo] sweep: ${gone} sandboxes deleted, ${pruned} old log files removed`)
  } catch (e) {
    log(`[demo] sweep failed: ${(e as Error).message}`)
  }
}
sweep()
setInterval(sweep, 10 * 60_000).unref()

const server = serve({ fetch: gateway.fetch, port: config.port, hostname: config.host }, () =>
  log(
    `[demo] pleatkit public demo on http://${config.host}:${config.port} (${config.mode === 'live' ? `LIVE via ${live?.name}, $${config.budget.dailyUsd}/day, ${config.budget.dailyRequests} requests/day, ${config.budget.perVisitor} per visitor` : 'SCRIPTED'}; state ${config.stateDir}; data ${config.dataDir})`,
  ),
)
const stop = () => {
  server.close(() => {
    visitors.closeAll()
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 5_000).unref()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
