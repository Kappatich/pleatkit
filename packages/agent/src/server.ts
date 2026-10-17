import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import type { AgentResult, AgentRunRequest, RequestStatus } from '@morphkit/runtime/compiler'
import { loopRunner, validateRequest, type AgentLimits, type AgentRunner } from './loop.js'
import type { ModelProvider } from './types.js'

export interface AgentServerOptions {
  /** The built-in loop over a model provider... */
  provider?: ModelProvider
  /** ...or any other harness (takes precedence). */
  runner?: AgentRunner
  limits?: Partial<AgentLimits>
  /** @morphkit/store-server base URL; when set, every run is logged there (request, verdict, tool log). */
  storeUrl?: string | null
  /** Allowed browser origin when the app calls the agent cross-origin. */
  corsOrigin?: string | null
  /** Route prefix. Default `/agent`. */
  basePath?: string
  log?: (line: string) => void
}

function statusFor(result: Omit<AgentResult, 'requestId'>): RequestStatus {
  if (result.verdict === 'needs-backend') return 'pending-admin'
  if (result.verdict === 'failed') return 'failed'
  return Object.keys(result.files).length > 0 || result.deleted.length > 0 ? 'proposed' : 'applied'
}

/** Log the run in store-server (server to server, so the tool log does not depend on the browser). */
export async function reportRun(storeUrl: string, req: AgentRunRequest, result: Omit<AgentResult, 'requestId'>): Promise<string | null> {
  const res = await fetch(`${storeUrl.replace(/\/$/, '')}/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-morphkit-user': req.userId, 'x-morphkit-app': req.appId ?? 'default', 'x-morphkit-agent': '1' },
    body: JSON.stringify({
      userId: req.userId,
      text: req.request,
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
      ...(result.attachments ? { attachments: result.attachments } : {}),
    }),
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) throw new Error(`store-server responded ${res.status}`)
  return ((await res.json()) as { id: string }).id
}

export function createAgentApp(options: AgentServerOptions) {
  const log = options.log ?? ((line: string) => console.log(line))
  const runner = options.runner ?? (options.provider ? loopRunner(options.provider) : null)
  if (!runner) throw new Error('createAgentApp needs a provider or a runner')
  const app = new Hono().basePath(options.basePath ?? '/agent')
  if (options.corsOrigin) app.use('*', cors({ origin: options.corsOrigin }))

  app.get('/health', (c) => c.json({ ok: true, provider: runner.name, model: runner.model, store: Boolean(options.storeUrl) }))

  app.post('/run', async (c) => {
    let req: AgentRunRequest
    try {
      req = validateRequest(await c.req.json())
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    return streamSSE(c, async (stream) => {
      const abort = new AbortController()
      stream.onAbort(() => abort.abort(new Error('client disconnected')))
      const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => undefined)
      try {
        const result = await runner.run(req, { limits: options.limits, signal: abort.signal, onProgress: (p) => void send('progress', p) })
        let requestId: string | null = null
        if (options.storeUrl) {
          requestId = await reportRun(options.storeUrl, req, result).catch((e: Error) => {
            log(`[morphkit-agent] could not log the request in store-server: ${e.message}`)
            return null
          })
        }
        const cost = result.usage.reduce((s, u) => s + (u.costUsd ?? 0), 0)
        log(
          `[morphkit-agent] ${req.userId}: ${result.verdict} in ${result.timings.totalMs} ms, ${result.modelCalls} model calls, ` +
            `${result.log.length} tool calls${cost ? `, $${cost.toFixed(4)}` : ''} (${result.provider}/${result.model})`,
        )
        await send('result', { ...result, requestId })
      } catch (e) {
        await send('error', { message: (e as Error).message })
      }
    })
  })

  return app
}
