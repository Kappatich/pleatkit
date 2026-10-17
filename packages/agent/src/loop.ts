import type { AgentProgress, AgentResult, AgentRunRequest, RequestClass } from '@morphkit/runtime/compiler'
import { UsageMeter } from './pricing.js'
import { buildPrompt, classifierContext } from './prompt.js'
import { ToolRunner, TOOLS } from './tools.js'
import type { ModelProvider, ToolCall, ToolResult } from './types.js'
import { Workspace } from './workspace.js'

export interface AgentLimits {
  /** Model calls in the main loop. */
  maxModelCalls: number
  timeoutMs: number
  /** Output tokens (thinking included) for one edit, summed over all model calls. */
  maxOutputTokens: number
}

export const DEFAULT_LIMITS: AgentLimits = { maxModelCalls: 12, timeoutMs: 90_000, maxOutputTokens: 8_000 }

export interface RunOptions {
  limits?: Partial<AgentLimits>
  /** Run the cheap classifier first (default true). Migrations skip it. */
  classify?: boolean
  onProgress?: (p: AgentProgress) => void
  /** Aborts the run, e.g. when the browser disconnects. */
  signal?: AbortSignal
}

/** `src/dynamic/customer-card.tsx` → "the customer card"; non-panel files get a generic name. */
export function humanName(path: unknown, req: Pick<AgentRunRequest, 'context' | 'components'>): string {
  if (typeof path !== 'string') return 'the page'
  const root = req.context.dynamicRoots.find((r) => path.startsWith(r))
  if (root && req.components.includes(path)) {
    return 'the ' + path.slice(root.length).replace(/\.\w+$/, '').replace(/[-_/]+/g, ' ').trim()
  }
  if (root) return 'a helper of the page'
  return "the app's data and helpers"
}

/** Plain-language progress line for a tool call. Never code or file paths: the end user reads these. */
export function describe(call: ToolCall, req: Pick<AgentRunRequest, 'context' | 'components'>): string {
  switch (call.name) {
    case 'list_files':
      return 'Looking around the page'
    case 'read_file':
      return `Looking at ${humanName(call.input.path, req)}`
    case 'write_file':
      return `Changing ${humanName(call.input.path, req)}`
    case 'check':
      return 'Checking that everything still works'
    case 'finish':
      return 'Wrapping up'
    default:
      return 'Working'
  }
}

/**
 * Something that turns one request into an AgentResult. The built-in loop (`loopRunner`) drives any
 * ModelProvider through the five tools; another harness (e.g. the Claude Agent SDK, TASKS stage 2.5) can be
 * plugged into the server by implementing this, reusing `Workspace` and `ToolRunner` for the same tools.
 */
export interface AgentRunner {
  readonly name: string
  readonly model: string
  run(req: AgentRunRequest, options?: RunOptions): Promise<Omit<AgentResult, 'requestId'>>
}

export function loopRunner(provider: ModelProvider, defaults: Partial<AgentLimits> = {}): AgentRunner {
  return {
    name: provider.name,
    model: provider.model,
    run: (req, options = {}) => runAgent(req, provider, { ...options, limits: { ...defaults, ...options.limits } }),
  }
}

export function validateRequest(body: unknown): AgentRunRequest {
  const b = body as Partial<AgentRunRequest> | null
  const isMap = (v: unknown) => typeof v === 'object' && v !== null && Object.values(v).every((s) => typeof s === 'string')
  if (!b || typeof b !== 'object') throw new Error('Body must be a JSON object')
  if (typeof b.userId !== 'string' || !b.userId) throw new Error('userId is required')
  if (typeof b.request !== 'string' || !b.request.trim()) throw new Error('request is required')
  if (b.request.length > 4000) throw new Error('request is too long (4000 characters max)')
  if (!isMap(b.files) || !isMap(b.readonly ?? {}) || !isMap(b.coreTypes ?? {})) throw new Error('files, readonly and coreTypes must map paths to strings')
  const ctx = b.context
  if (!ctx || !Array.isArray(ctx.dynamicRoots) || !Array.isArray(ctx.externals) || !Array.isArray(ctx.externalPatterns) || typeof ctx.alias !== 'object') {
    throw new Error('context { dynamicRoots, externals, externalPatterns, alias } is required')
  }
  return {
    ...b,
    readonly: b.readonly ?? {},
    coreTypes: b.coreTypes ?? {},
    components: Array.isArray(b.components) ? b.components.filter((c): c is string => typeof c === 'string') : [],
  } as AgentRunRequest
}

/** One edit: classify, then let the model use the tools until it calls finish or a limit is hit. */
export async function runAgent(req: AgentRunRequest, provider: ModelProvider, options: RunOptions = {}): Promise<Omit<AgentResult, 'requestId'>> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  const progress = options.onProgress ?? (() => undefined)
  const started = performance.now()
  const timeout = AbortSignal.timeout(limits.timeoutMs)
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
  const meter = new UsageMeter()
  const ws = new Workspace(req)
  const timings = { totalMs: 0, classifyMs: null as number | null, modelMs: 0, toolsMs: 0 }
  let classification: RequestClass | null = null
  let modelCalls = 0
  let stopReason: AgentResult['stopReason']

  const runner = new ToolRunner(ws, (entry, call) => {
    if (call.name === 'check' || (call.name === 'finish' && !entry.ok)) {
      const ok = entry.ok && !entry.result.startsWith('FAILED')
      progress({ type: 'check', ok, errorCount: ws.lastCheck?.errors.length ?? 0, text: ok ? 'Everything works' : 'Found a problem, fixing it' })
    }
  })

  const done = (verdict: AgentResult['verdict'], summary: string): Omit<AgentResult, 'requestId'> => {
    timings.totalMs = Math.round(performance.now() - started)
    return {
      verdict,
      summary,
      files: verdict === 'ok' ? ws.changedFiles() : {},
      deleted: verdict === 'ok' ? ws.deleted() : [],
      log: runner.log,
      classification,
      provider: provider.name,
      model: provider.model,
      usage: meter.rows(),
      modelCalls,
      timings: { ...timings, modelMs: Math.round(timings.modelMs), toolsMs: Math.round(timings.toolsMs), classifyMs: timings.classifyMs === null ? null : Math.round(timings.classifyMs) },
      ...(stopReason ? { stopReason } : {}),
    }
  }

  try {
    if (options.classify !== false && !req.migration) {
      progress({ type: 'status', text: 'Understanding the request' })
      const t = performance.now()
      try {
        const c = await provider.classify({ request: req.request, context: classifierContext(req) }, signal)
        if (c.usage && c.model) meter.add(c.model, c.usage)
        classification = c.label
        timings.classifyMs = performance.now() - t
        progress({ type: 'classified', label: c.label, text: c.label === 'needs-backend' ? 'This needs a change on the server' : 'This can be done on the page' })
        if (c.label === 'needs-backend') {
          return done('needs-backend', c.reason || 'This needs a change on the server, so I passed it to the administrator.')
        }
      } catch (e) {
        if (signal.aborted) throw e
        timings.classifyMs = performance.now() - t
        progress({ type: 'status', text: 'Thinking it over' })
      }
    }

    const session = provider.start(buildPrompt(req), TOOLS, { request: req.request })
    let results: ToolResult[] = []
    let usedOutput = 0
    let nudged = false
    while (!runner.finished) {
      if (modelCalls >= limits.maxModelCalls) {
        stopReason = 'calls'
        break
      }
      if (usedOutput >= limits.maxOutputTokens) {
        stopReason = 'output-tokens'
        break
      }
      progress({ type: 'model', turn: modelCalls + 1, text: modelCalls === 0 ? 'Planning the change' : 'Thinking' })
      const t = performance.now()
      const turn = await session.next(results, { signal, maxOutputTokens: limits.maxOutputTokens - usedOutput })
      timings.modelMs += performance.now() - t
      modelCalls++
      meter.add(turn.model, turn.usage)
      usedOutput += turn.usage.outputTokens
      // The model's own text is not forwarded: it may contain code. It stays out of the user's view.
      if (turn.stop === 'refusal') {
        stopReason = 'refusal'
        break
      }
      results = []
      if (turn.toolCalls.length === 0) {
        if (nudged) {
          stopReason = 'no-finish'
          break
        }
        nudged = true
        session.say('Call the finish tool now: verdict "ok" if your changes are written and check passes, otherwise "needs-backend" or "failed".')
        continue
      }
      const tt = performance.now()
      for (const call of turn.toolCalls) {
        progress({ type: 'tool', turn: modelCalls, tool: call.name, text: describe(call, req) })
        results.push(await runner.run(call, modelCalls))
        if (runner.finished) break
      }
      timings.toolsMs += performance.now() - tt
    }
  } catch (e) {
    if (signal.aborted) {
      stopReason = 'timeout'
      return done('failed', timeout.aborted ? `I ran out of time (${Math.round(limits.timeoutMs / 1000)} s) and did not change anything.` : 'Cancelled.')
    }
    stopReason = 'error'
    return done('failed', `The agent failed: ${(e as Error).message}`)
  }

  const fin = runner.finished
  if (fin) return done(fin.verdict, fin.summary)
  const why =
    stopReason === 'calls'
      ? `I reached the limit of ${limits.maxModelCalls} steps`
      : stopReason === 'output-tokens'
        ? `I reached the output budget of ${limits.maxOutputTokens} tokens`
        : stopReason === 'refusal'
          ? 'The model declined this request'
          : 'The model stopped without finishing'
  return done('failed', `${why} and did not change anything.`)
}
