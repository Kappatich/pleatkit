import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import type { AgentRefusal, AgentResult, AgentRunRequest, RequestStatus } from '@morphkit/runtime/compiler'
import { AgentAuthError, identify, type AgentAuth, type Identity } from './auth.js'
import { BundleService, type CompileInput } from './bundle.js'
import { t, type MessageKey } from './i18n.js'
import { loopRunner, validateRequest, type AgentLimits, type AgentRunner } from './loop.js'
import { MemoryQuotaBackend, Quotas, resolvePlan, StoreQuotaBackend, type PlanLimits } from './quota.js'
import { StoreClient } from './store-client.js'
import type { ModelProvider } from './types.js'

export interface AgentServerOptions {
  /** The built-in loop over a model provider... */
  provider?: ModelProvider
  /** ...or any other harness (takes precedence). */
  runner?: AgentRunner
  limits?: Partial<AgentLimits>
  /** @morphkit/store-server base URL; when set, every run is logged there (request, verdict, tool log). */
  storeUrl?: string | null
  /** Credentials (V1 A1). Default: none, development (requests are trusted as sent). */
  auth?: AgentAuth
  /**
   * Quotas (V1 A4). Default: buckets in store-server when `storeUrl` is set, otherwise in this process; plan
   * limits from store-server's per-app plan over `plan` (default: the `free` plan).
   */
  quotas?: Quotas | false
  /** Plan name and overrides used when store-server has none for the app (MORPHKIT_PLAN / MORPHKIT_LIMITS). */
  plan?: { name?: string; limits?: Record<string, number> }
  /** Allowed browser origin when the app calls the agent cross-origin. */
  corsOrigin?: string | null
  /** Route prefix. Default `/agent`. */
  basePath?: string
  log?: (line: string) => void
  fetch?: typeof fetch
}

function statusFor(result: Omit<AgentResult, 'requestId'>): RequestStatus {
  if (result.verdict === 'needs-backend') return 'pending-admin'
  if (result.verdict === 'failed') return 'failed'
  if (result.verdict === 'clarify') return 'clarifying'
  if (result.verdict === 'refused') return 'refused'
  return Object.keys(result.files).length > 0 || result.deleted.length > 0 ? 'proposed' : 'applied'
}

/** Log the run in store-server (server to server, so the tool log does not depend on the browser). */
export async function reportRun(store: StoreClient | string, req: AgentRunRequest, result: Omit<AgentResult, 'requestId'>, who?: Identity): Promise<string | null> {
  const client = typeof store === 'string' ? new StoreClient(store, null) : store
  const identity = who ?? { appId: req.appId ?? 'default', userId: req.userId, orgId: 'default', environment: null }
  const r = await client.call<{ id: string }>('POST', '/requests', identity, {
    userId: identity.userId,
    text: req.clarification ? `${req.request}\n(answer: ${req.clarification.answer})` : req.request,
    target: req.target ?? null,
    verdict: result.verdict,
    summary: result.summary,
    status: statusFor(result),
    classification: result.classification,
    provider: result.provider,
    model: result.model,
    usage: result.usage,
    timings: result.timings,
    log: result.log,
    files: result.files,
    ...(result.error ? { error: result.error } : {}),
    ...(result.refusal ? { error: `refused: ${result.refusal}` } : {}),
    ...(result.attachments ? { attachments: result.attachments } : {}),
  })
  return r.id
}

/** A result for a request that is not run at all (quota, kill switch): fixed text, no model call. */
function refusedResult(req: AgentRunRequest, refusal: AgentRefusal, key: MessageKey, runner: AgentRunner): Omit<AgentResult, 'requestId'> {
  return {
    verdict: 'refused',
    refusal,
    summary: t(req.locale, key),
    files: {},
    deleted: [],
    log: [],
    classification: null,
    provider: runner.name,
    model: runner.model,
    usage: [],
    modelCalls: 0,
    timings: { totalMs: 0, classifyMs: null, modelMs: 0, toolsMs: 0 },
  }
}

export function createAgentApp(options: AgentServerOptions) {
  const log = options.log ?? ((line: string) => console.log(line))
  const runner = options.runner ?? (options.provider ? loopRunner(options.provider) : null)
  if (!runner) throw new Error('createAgentApp needs a provider or a runner')
  const auth: AgentAuth = options.auth ?? { credentials: null, production: false }
  const store = options.storeUrl ? new StoreClient(options.storeUrl, auth.credentials, options.fetch) : null
  const fallbackPlan = (): PlanLimits => resolvePlan(options.plan?.name, options.plan?.limits)
  const quotas =
    options.quotas === false
      ? null
      : (options.quotas ??
        new Quotas(store ? new StoreQuotaBackend(store) : new MemoryQuotaBackend(), async (appId) => {
          if (!store) return fallbackPlan()
          const p = await store.plan(appId).catch(() => null)
          return p ? resolvePlan(p.plan ?? options.plan?.name, { ...options.plan?.limits, ...p.limits }) : fallbackPlan()
        }))

  const bundles = new BundleService(auth.credentials, store)

  const app = new Hono().basePath(options.basePath ?? '/agent')
  if (options.corsOrigin) app.use('*', cors({ origin: options.corsOrigin, allowHeaders: ['content-type', 'authorization', 'idempotency-key'] }))

  const health = (c: Context) => c.json({ ok: true, provider: runner.name, model: runner.model, store: Boolean(store), auth: Boolean(auth.credentials) })
  app.get('/health', health)
  app.get('/v1/health', health)

  const run = async (c: Context) => {
    let req: AgentRunRequest
    let who: Identity
    try {
      const body = (await c.req.json()) as Partial<AgentRunRequest>
      who = await identify(c.req.header('authorization'), body, auth)
      // the token decides who and which app; the body cannot claim another user
      req = validateRequest({ ...body, userId: who.userId, appId: who.appId })
    } catch (e) {
      if (e instanceof AgentAuthError) return c.json({ error: e.message }, e.status)
      return c.json({ error: (e as Error).message }, 400)
    }
    return streamSSE(c, async (stream) => {
      const abort = new AbortController()
      stream.onAbort(() => abort.abort(new Error('client disconnected')))
      const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => undefined)
      try {
        let result: Omit<AgentResult, 'requestId'>
        let plan: PlanLimits | null = null
        const quota = quotas ? await quotas.beforeEdit(who) : null
        if (quota && !quota.ok) {
          result = refusedResult(req, 'quota', quota.limit?.startsWith('app') ? 'quotaApp' : 'quotaUser', runner)
          log(`[morphkit-agent] ${who.appId}/${who.userId}: refused, over the ${quota.limit} limit`)
        } else {
          plan = quota?.plan ?? null
          const limits = { ...options.limits, ...(plan ? { maxCostUsd: Math.min(plan.perEditUsd, options.limits?.maxCostUsd ?? Infinity) } : {}) }
          result = await runner.run(req, { limits, signal: abort.signal, onProgress: (p) => void send('progress', p) })
        }
        const cost = result.usage.reduce((s, u) => s + (u.costUsd ?? 0), 0)
        if (quotas && cost > 0) await quotas.afterEdit(who, cost).catch((e: Error) => log(`[morphkit-agent] could not record the cost: ${e.message}`))
        let requestId: string | null = null
        if (store) {
          requestId = await reportRun(store, req, result, who).catch((e: Error) => {
            log(`[morphkit-agent] could not log the request in store-server: ${e.message}`)
            return null
          })
        }
        log(
          `[morphkit-agent] ${who.userId}: ${result.verdict} in ${result.timings.totalMs} ms, ${result.modelCalls} model calls, ` +
            `${result.log.length} tool calls${cost ? `, $${cost.toFixed(4)}` : ''} (${result.provider}/${result.model})`,
        )
        // compile: 'server' (V1 B1): compile, sign and store the resulting snapshot now, so the browser's commit
        // is a download of a verified bundle
        if (req.compile && result.verdict === 'ok' && (Object.keys(result.files).length > 0 || result.deleted.length > 0 || req.migration)) {
          const files = { ...req.files, ...result.files }
          for (const p of result.deleted) delete files[p]
          const out = await bundles
            .compile({ appId: who.appId, files, readonly: req.readonly, context: req.context, components: req.components })
            .catch((e: Error) => (log(`[morphkit-agent] server compile after the run failed: ${e.message}`), null))
          if (out?.ok && out.key) result = { ...result, bundle: { key: out.key, filesHash: out.filesHash, compileMs: out.timeMs } }
        }
        await send('result', { ...result, requestId })
      } catch (e) {
        await send('error', { message: (e as Error).message })
      }
    })
  }
  app.post('/run', run)
  app.post('/v1/run', run)

  /** Compile, sign and store one snapshot (server compile mode, V1 B1); `check: true` only reports errors. */
  app.post('/v1/compile', async (c) => {
    let who: Identity
    let input: CompileInput
    let check = false
    try {
      const body = (await c.req.json()) as Partial<CompileInput> & { userId?: string; check?: boolean }
      who = await identify(c.req.header('authorization'), body, auth)
      if (!who.userId) throw new Error('userId is required')
      const isMap = (v: unknown) => typeof v === 'object' && v !== null && Object.values(v).every((s) => typeof s === 'string')
      if (!isMap(body.files) || !isMap(body.readonly ?? {})) throw new Error('files and readonly must map paths to strings')
      const ctx = body.context
      if (!ctx || !Array.isArray(ctx.dynamicRoots) || !Array.isArray(ctx.externals) || !Array.isArray(ctx.externalPatterns) || typeof ctx.alias !== 'object') {
        throw new Error('context { dynamicRoots, externals, externalPatterns, alias } is required')
      }
      check = body.check === true
      input = {
        appId: who.appId,
        files: body.files as Record<string, string>,
        readonly: (body.readonly ?? {}) as Record<string, string>,
        context: { ...ctx, namespace: who.appId },
        components: Array.isArray(body.components) ? body.components.filter((x): x is string => typeof x === 'string') : [],
      }
    } catch (e) {
      if (e instanceof AgentAuthError) return c.json({ error: e.message }, e.status)
      return c.json({ error: (e as Error).message }, 400)
    }
    if (quotas && !check) {
      const q = await quotas.beforeCompile(who)
      if (!q.ok) return c.json({ error: 'over the daily compile limit', retryAfterMs: q.retryAfterMs ?? null }, 429)
    }
    try {
      return c.json(await bundles.compile(input, { check }))
    } catch (e) {
      log(`[morphkit-agent] compile failed: ${(e as Error).message}`)
      return c.json({ error: 'compile failed' }, 500)
    }
  })

  /** Signed bundles this process compiled (or store-server has), for apps that proxy `/morphkit/b` to the agent. */
  app.get('/v1/b/:app/:file', async (c) => {
    const f = await bundles.file(c.req.param('app'), c.req.param('file'))
    if (!f) return c.json({ error: 'not found' }, 404)
    return c.body(f.body, 200, {
      'content-type': f.type,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'access-control-allow-origin': '*',
    })
  })

  return app
}
