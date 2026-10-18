import { AGENT_IMAGE_TYPES, MAX_AGENT_IMAGE_BYTES, MAX_AGENT_IMAGES, MAX_TARGET_DOM_CHARS } from '@pleatkit/runtime/compiler'
import type { AgentImage, AgentProgress, AgentResult, AgentRunRequest, FileMap, RequestClass } from '@pleatkit/runtime/compiler'
import { t } from './i18n.js'
import { UsageMeter } from './pricing.js'
import { buildPrompt, classifierContext, PROMPT_VERSION, type PromptDigests } from './prompt.js'
import { checkText, ToolRunner, TOOLS } from './tools.js'
import type { ModelProvider, ModelTurn, ToolCall, ToolResult } from './types.js'
import { Workspace, type TypecheckFn } from './workspace.js'

export interface AgentLimits {
  /** Model calls in the main loop. */
  maxModelCalls: number
  timeoutMs: number
  /**
   * Visible output tokens (text and tool calls) for one edit, summed over all model calls. Thinking is not
   * counted and not limited (DECISIONS item 11); it is reported in `AgentResult.output` and billed in `usage`.
   */
  maxOutputTokens: number
  /** Model cost of one edit in USD (the app plan's `perEditUsd`, V1 A4). Unknown prices are not counted. */
  maxCostUsd: number
}

/**
 * Visible output tokens of one model turn. Exact when the API reports the thinking share
 * (`thinkingTokens`), otherwise estimated from the visible content (~3.5 characters per token).
 */
export function visibleOutputTokens(turn: Pick<ModelTurn, 'text' | 'toolCalls' | 'usage'>): { tokens: number; estimated: boolean } {
  const out = turn.usage.outputTokens
  if (turn.usage.thinkingTokens !== undefined) return { tokens: Math.max(0, out - turn.usage.thinkingTokens), estimated: false }
  const chars = turn.text.length + turn.toolCalls.reduce((s, c) => s + c.name.length + JSON.stringify(c.input).length, 0)
  return { tokens: Math.min(out, Math.ceil(chars / 3.5)), estimated: true }
}

/** The result a cut-off tool call gets instead of running. */
export const CUT_OFF = 'Not run: your reply hit the output limit while writing this call, so it was cut off. Nothing was written. Make smaller changes: edit_file for a part of a file, or one file per call.'

export const DEFAULT_LIMITS: AgentLimits = { maxModelCalls: 12, timeoutMs: 90_000, maxOutputTokens: 8_000, maxCostUsd: Number.POSITIVE_INFINITY }

export interface RunOptions {
  limits?: Partial<AgentLimits>
  /** Protected elements and the release's original files, from the server manifest (brainstorm 05 #20). */
  protected?: string[]
  base?: FileMap
  /** Type check against the app's `.d.ts` after a clean compile (brainstorm 05 #4). */
  typecheck?: TypecheckFn | null
  /** Design-system and data-contract digests from the server manifest (cached prompt prefix). */
  digests?: PromptDigests
  /** Run the cheap classifier first (default true). Migrations skip it. */
  classify?: boolean
  onProgress?: (p: AgentProgress) => void
  /** Aborts the run, e.g. when the browser disconnects. */
  signal?: AbortSignal
}

/** `src/dynamic/customer-card.tsx` → "the customer card"; non-panel files get a generic name. */
export function humanName(path: unknown, req: Pick<AgentRunRequest, 'context' | 'components' | 'locale'>): string {
  if (typeof path !== 'string') return t(req.locale, 'page')
  const root = req.context.dynamicRoots.find((r) => path.startsWith(r))
  if (root && req.components.includes(path)) {
    return t(req.locale, 'panel', { name: path.slice(root.length).replace(/\.\w+$/, '').replace(/[-_/]+/g, ' ').trim() })
  }
  if (root) return t(req.locale, 'helper')
  return t(req.locale, 'dataHelpers')
}

/** Plain-language progress line for a tool call. Never code or file paths: the end user reads these. */
export function describe(call: ToolCall, req: Pick<AgentRunRequest, 'context' | 'components' | 'locale'>): string {
  switch (call.name) {
    case 'list_files':
      return t(req.locale, 'lookingAround')
    case 'read_file':
      return t(req.locale, 'looking', { name: humanName(call.input.path, req) })
    case 'write_file':
    case 'edit_file':
      return t(req.locale, 'changing', { name: humanName(call.input.path, req) })
    case 'check':
      return t(req.locale, 'checking')
    case 'finish':
      return t(req.locale, 'wrappingUp')
    default:
      return t(req.locale, 'working')
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
  const images = validateImages(b.images)
  const cl = b.clarification as { question?: unknown; answer?: unknown } | undefined
  if (cl !== undefined && (typeof cl !== 'object' || cl === null || typeof cl.question !== 'string' || typeof cl.answer !== 'string' || !cl.answer.trim())) {
    throw new Error('clarification must be { question, answer } strings')
  }
  if (b.targetDom !== undefined && typeof b.targetDom !== 'string') throw new Error('targetDom must be a string')
  return {
    ...b,
    ...(images ? { images } : {}),
    ...(typeof b.targetDom === 'string' ? { targetDom: b.targetDom.slice(0, MAX_TARGET_DOM_CHARS) } : {}),
    readonly: b.readonly ?? {},
    coreTypes: b.coreTypes ?? {},
    components: Array.isArray(b.components) ? b.components.filter((c): c is string => typeof c === 'string') : [],
  } as AgentRunRequest
}

/**
 * One edit: classify (unless the user pointed at a panel), then let the model use the tools until it calls
 * finish or a limit is hit.
 */
/** Screenshots: known image types, base64, at most MAX_AGENT_IMAGES and MAX_AGENT_IMAGE_BYTES in total. */
function validateImages(raw: unknown): AgentImage[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new Error('images must be an array')
  if (raw.length > MAX_AGENT_IMAGES) throw new Error(`at most ${MAX_AGENT_IMAGES} images per request`)
  let bytes = 0
  const out = raw.map((i: Partial<AgentImage> | null, n) => {
    if (!i || !(AGENT_IMAGE_TYPES as readonly string[]).includes(i.mediaType ?? '')) throw new Error(`images[${n}].mediaType must be one of ${AGENT_IMAGE_TYPES.join(', ')}`)
    if (typeof i.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(i.data)) throw new Error(`images[${n}].data must be base64 without a data: prefix`)
    bytes += Math.floor((i.data.length * 3) / 4)
    return { mediaType: i.mediaType as AgentImage['mediaType'], data: i.data, ...(typeof i.name === 'string' ? { name: i.name.slice(0, 200) } : {}) }
  })
  if (bytes > MAX_AGENT_IMAGE_BYTES) throw new Error(`images are too large (${Math.round(bytes / 1024)} KB, at most ${MAX_AGENT_IMAGE_BYTES / 1024} KB in total)`)
  return out.length ? out : undefined
}

export async function runAgent(req: AgentRunRequest, provider: ModelProvider, options: RunOptions = {}): Promise<Omit<AgentResult, 'requestId'>> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  const progress = options.onProgress ?? (() => undefined)
  const lang = req.locale
  const started = performance.now()
  const timeout = AbortSignal.timeout(limits.timeoutMs)
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
  const meter = new UsageMeter()
  const ws = new Workspace({ ...req, ...(options.protected?.length ? { protected: options.protected, base: options.base ?? {} } : {}) }, options.typecheck ?? null)
  const timings = { totalMs: 0, classifyMs: null as number | null, modelMs: 0, toolsMs: 0 }
  const output = { visibleTokens: 0, thinkingTokens: 0, limit: limits.maxOutputTokens, estimated: false }
  let classification: RequestClass | null = null
  let modelCalls = 0
  let stopReason: AgentResult['stopReason']
  let error: string | undefined
  let clarify: AgentResult['clarify']
  let refusal: AgentResult['refusal']
  let backendNote: string | undefined
  const intent: { intentLabel?: string; gist?: string } = {}
  const spent = () => meter.rows().reduce((sum, r) => sum + (r.costUsd ?? 0), 0)

  const runner: ToolRunner = new ToolRunner(ws, (entry, call) => {
    if (call.name === 'check' || (call.name === 'finish' && !entry.ok)) {
      const ok = entry.ok && !entry.result.startsWith('FAILED')
      progress({ type: 'check', ok, errorCount: ws.lastCheck?.errors.length ?? 0, text: t(lang, ok ? 'checkOk' : 'checkFailed') })
    }
  })

  const done = (verdict: AgentResult['verdict'], summary: string): Omit<AgentResult, 'requestId'> => {
    timings.totalMs = Math.round(performance.now() - started)
    return {
      verdict,
      summary,
      files: verdict === 'ok' || verdict === 'partial' ? ws.changedFiles() : {},
      deleted: verdict === 'ok' || verdict === 'partial' ? ws.deleted() : [],
      log: runner.log,
      classification,
      provider: provider.name,
      model: provider.model,
      promptVersion: PROMPT_VERSION,
      usage: meter.rows(),
      modelCalls,
      output,
      attachments: {
        images: req.images?.length ?? 0,
        imageBytes: (req.images ?? []).reduce((s, i) => s + Math.floor((i.data.length * 3) / 4), 0),
        targetDomChars: req.targetDom?.length ?? 0,
      },
      timings: { ...timings, modelMs: Math.round(timings.modelMs), toolsMs: Math.round(timings.toolsMs), classifyMs: timings.classifyMs === null ? null : Math.round(timings.classifyMs) },
      ...(stopReason ? { stopReason } : {}),
      ...(error ? { error } : {}),
      ...(clarify ? { clarify } : {}),
      ...(refusal ? { refusal } : {}),
      ...(backendNote ? { backendNote } : {}),
      ...intent,
    }
  }

  try {
    // Pointing at a panel already says "this is about the page": skip the classifier (DECISIONS item 17).
    // After the user answered the clarifying question it is skipped too: one question per edit at most.
    if (options.classify !== false && !req.migration && !req.target && !req.clarification) {
      progress({ type: 'status', text: t(lang, 'understanding') })
      const startedAt = performance.now()
      try {
        const c = await provider.classify({ request: req.request, context: classifierContext(req) }, signal)
        if (c.usage && c.model) meter.add(c.model, c.usage)
        classification = c.label
        if (c.intentLabel) intent.intentLabel = c.intentLabel
        if (c.gist) intent.gist = c.gist
        timings.classifyMs = performance.now() - startedAt
        const ask = c.label === 'unclear' && c.question && c.options && c.options.length >= 2
        if (c.label !== 'off-topic') progress({ type: 'classified', label: c.label, text: t(lang, c.label === 'needs-backend' ? 'classifiedBackend' : ask ? 'classifiedUnclear' : 'classifiedUi') })
        if (c.label === 'off-topic') {
          // one cheap fixed reply; the big model is never called for it (V1 A4)
          refusal = 'off-topic'
          return done('refused', t(lang, 'offTopic'))
        }
        if (c.label === 'needs-backend') {
          return done('needs-backend', c.reason || t(lang, 'needsBackendDefault'))
        }
        if (ask) {
          // one question with buttons instead of a guess; nothing is changed and the big model is not called
          clarify = { question: c.question!, options: c.options! }
          return done('clarify', c.question!)
        }
      } catch (e) {
        if (signal.aborted) throw e
        timings.classifyMs = performance.now() - startedAt
        progress({ type: 'status', text: t(lang, 'thinkingOver') })
      }
    }

    // one clarifying question per edit (brainstorm 04 §3): after the user answered, finish("clarify") is refused
    runner.clarified = Boolean(req.clarification)
    const session = provider.start(buildPrompt(req, limits, options.digests ?? {}), TOOLS, { request: req.request })
    let results: ToolResult[] = []
    let nudged = false
    while (!runner.finished) {
      if (modelCalls >= limits.maxModelCalls) {
        stopReason = 'calls'
        break
      }
      if (output.visibleTokens >= limits.maxOutputTokens) {
        stopReason = 'output-tokens'
        break
      }
      if (spent() >= limits.maxCostUsd) {
        stopReason = 'cost'
        break
      }
      progress(modelCalls === 0 ? { type: 'model', turn: 1, text: t(lang, 'planning') } : { type: 'model', turn: modelCalls + 1, text: t(lang, 'thinking'), transient: true })
      const startedAt = performance.now()
      const turn = await session.next(results, { signal, maxOutputTokens: limits.maxOutputTokens - output.visibleTokens })
      timings.modelMs += performance.now() - startedAt
      modelCalls++
      meter.add(turn.model, turn.usage)
      const visible = visibleOutputTokens(turn)
      output.visibleTokens += visible.tokens
      output.thinkingTokens += turn.usage.outputTokens - visible.tokens
      output.estimated ||= visible.estimated && turn.usage.outputTokens > 0
      // The model's own text is not forwarded: it may contain code. It stays out of the user's view.
      if (turn.stop === 'refusal') {
        stopReason = 'refusal'
        break
      }
      results = []
      // Output cut off by max_tokens (code review 06 item 10): the last tool call may be incomplete (a half-written
      // file), so it is not run; the model is told, and gets a result for it so the conversation stays valid.
      let cutOff: ToolCall | null = null
      if (turn.stop === 'max_tokens' && turn.toolCalls.length > 0) cutOff = turn.toolCalls.pop()!
      if (turn.stop === 'max_tokens' && turn.toolCalls.length === 0 && !cutOff) {
        session.say('Your reply was cut off at the output limit. Continue with smaller tool calls (edit_file for part of a file).')
        continue
      }
      if (turn.toolCalls.length === 0 && cutOff) {
        runner.note(cutOff, modelCalls, CUT_OFF)
        results.push({ id: cutOff.id, ok: false, content: CUT_OFF })
        continue
      }
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
      if (cutOff && !runner.finished) {
        runner.note(cutOff, modelCalls, CUT_OFF)
        results.push({ id: cutOff.id, ok: false, content: CUT_OFF })
      }
      // automatic check after a turn that wrote files (brainstorm 04 §2): the model sees the result with its
      // writes and does not spend a call on check
      if (runner.wroteSinceCheck && !runner.finished) {
        const r = await ws.check()
        runner.wroteSinceCheck = false
        progress({ type: 'check', ok: r.ok, errorCount: r.errors.length, text: t(lang, r.ok ? 'checkOk' : 'checkFailed') })
        const last = [...results].reverse().find((x) => x.ok)
        if (last) last.content += `\n\nAutomatic check after this turn: ${checkText(r)}`
      }
      timings.toolsMs += performance.now() - tt
    }
  } catch (e) {
    if (signal.aborted) {
      stopReason = 'timeout'
      return done('failed', timeout.aborted ? t(lang, 'outOfTime', { seconds: Math.round(limits.timeoutMs / 1000) }) : t(lang, 'cancelled'))
    }
    stopReason = 'error'
    // the technical message is for the admin's request log, not for the user
    error = (e as Error).message
    return done('failed', t(lang, 'agentFailed'))
  }

  const fin = runner.finished
  if (fin) {
    if (fin.clarify) clarify = fin.clarify
    if (fin.backendNote) backendNote = fin.backendNote
    return done(fin.verdict, fin.summary)
  }
  const why =
    stopReason === 'calls'
      ? t(lang, 'limitCalls', { n: limits.maxModelCalls })
      : stopReason === 'output-tokens'
        ? t(lang, 'limitOutput')
        : stopReason === 'cost'
          ? t(lang, 'limitCost')
        : stopReason === 'refusal'
          ? t(lang, 'refused')
          : t(lang, 'noFinish')
  return done('failed', why)
}
