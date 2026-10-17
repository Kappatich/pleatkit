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

const base = (p: unknown) => (typeof p === 'string' ? p.replace(/^.*\//, '') : '?')

function describe(call: ToolCall): string {
  switch (call.name) {
    case 'list_files':
      return 'Looking at the files'
    case 'read_file':
      return `Reading ${base(call.input.path)}`
    case 'write_file':
      return `Writing ${base(call.input.path)}`
    case 'check':
      return 'Checking the build'
    case 'finish':
      return 'Finishing'
    default:
      return call.name
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
      progress({ type: 'check', ok: entry.ok && !entry.result.startsWith('FAILED'), errors: ws.lastCheck?.errors ?? [], text: entry.ok && !entry.result.startsWith('FAILED') ? 'Build OK' : 'Build failed, fixing' })
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
        progress({ type: 'classified', label: c.label, text: c.label === 'needs-backend' ? 'Needs a server change' : 'UI change' })
        if (c.label === 'needs-backend') {
          return done('needs-backend', c.reason || 'This needs a change on the server, so I passed it to the administrator.')
        }
      } catch (e) {
        if (signal.aborted) throw e
        timings.classifyMs = performance.now() - t
        progress({ type: 'status', text: `Classifier unavailable (${(e as Error).message}); continuing` })
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
      if (turn.text.trim()) progress({ type: 'model', turn: modelCalls, text: turn.text.trim().slice(0, 300) })
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
        progress({ type: 'tool', turn: modelCalls, tool: call.name, text: describe(call) })
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
