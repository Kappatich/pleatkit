import Anthropic from '@anthropic-ai/sdk'
import type { PleatkitManifest, TokenUsage } from '@pleatkit/runtime/compiler'
import type { PromptTokenCount } from '../prefix.js'
import { CLASSIFIER_INSTRUCTIONS, INTENT_LABELS } from '../prompt.js'
import { perCallMaxTokens } from './budget.js'
import type { Classification, ClassifyInput, ModelProvider, ModelSession, ModelTurn, PromptParts, ToolResult, ToolSpec, TurnOptions } from '../types.js'
import { CLUSTER_MAX_TOKENS, CLUSTER_SCHEMA, clusterMessage, parseClusters, WISHES_INSTRUCTIONS, type ClusterInput, type ClusterOutput } from '../wishes.js'

type MessageParam = Anthropic.Beta.BetaMessageParam
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AnthropicProviderOptions {
  apiKey: string
  /** Defaults to the SDK's own resolution (ANTHROPIC_BASE_URL or the public API). */
  baseURL?: string
  model?: string
  classifierModel?: string
  effort?: Effort
  /**
   * Server-side refusal fallback (`fallbacks: "default"`): a request a safety classifier declines is retried
   * on Anthropic's recommended fallback model inside the same call. On by default; PLEATKIT_FALLBACKS=off disables it.
   */
  fallbacks?: boolean
  /** For tests: a fetch that never reaches the network. */
  fetch?: typeof fetch
  /**
   * Stream each call (`messages.stream` + `finalMessage()`) with `eager_input_streaming` on the tools, so a large
   * write_file arrives as it is generated (brainstorm 04 §5). Off by default; PLEATKIT_STREAM=1. Tool inputs are
   * then not validated by the API: the tool runner checks every field itself.
   */
  stream?: boolean
  /**
   * DECISIONS 76.1: when the conversation tail is written to the prompt cache. `always` (every call, the default):
   * the first call writes the request's tail (the dynamic files) at 1.25× so a second call reads it at 0.1×;
   * `after-first` (the default, DECISIONS 76.1): the first call writes only the system prefix, so a one-call
   * edit sends the tail as plain input ($2/M, not $2.5/M) and a cancelled early call writes no tail at all
   * (the parallel classifier's non-edit requests cost ~$0.0001 instead of ~$0.025); a two-call edit then pays the
   * tail as input on the first call and writes it on the second. PLEATKIT_CACHE_TAIL=always for the old behavior.
   */
  cacheTail?: 'always' | 'after-first'
}

export const DEFAULT_MODEL = 'claude-sonnet-5-5'
export { MAX_TOKENS_PER_CALL } from './budget.js'
export const DEFAULT_CLASSIFIER_MODEL = 'claude-haiku-5-5'
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

interface WireUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  output_tokens_details?: { thinking_tokens?: number | null } | null
}

function usageOf(u: WireUsage): TokenUsage {
  const thinking = u.output_tokens_details?.thinking_tokens
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    ...(typeof thinking === 'number' ? { thinkingTokens: thinking } : {}),
  }
}

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string', enum: ['ui', 'needs-backend', 'unclear', 'off-topic', 'restore'] },
    reason: { type: 'string' },
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
    intent_label: { type: 'string', enum: [...INTENT_LABELS] },
    gist: { type: 'string' },
    backend_quote: { type: 'string' },
  },
  required: ['label', 'reason', 'question', 'options', 'intent_label', 'gist', 'backend_quote'],
  additionalProperties: false,
} as const

/** The intent label (closed list) and a gist without digits (DECISIONS 44). */
export function intentOf(p: { intent_label?: unknown; gist?: unknown }): { intentLabel?: string; gist?: string } {
  const label = typeof p.intent_label === 'string' && (INTENT_LABELS as readonly string[]).includes(p.intent_label) ? p.intent_label : undefined
  const gist = typeof p.gist === 'string' ? p.gist.replace(/\d+/g, '#').split(/\s+/).filter(Boolean).slice(0, 12).join(' ') : ''
  return { ...(label ? { intentLabel: label } : {}), ...(gist ? { gist } : {}) }
}

/** Question and options of an `unclear` classification, cleaned up (2 to 4 non-empty options). */
export function clarifyOf(p: { question?: unknown; options?: unknown }): { question?: string; options?: string[] } {
  const question = typeof p.question === 'string' ? p.question.trim() : ''
  const options = Array.isArray(p.options) ? p.options.filter((o): o is string => typeof o === 'string' && o.trim() !== '').map((o) => o.trim().slice(0, 80)).slice(0, 4) : []
  return question && options.length >= 2 ? { question: question.slice(0, 300), options } : {}
}

/** Claude through the official SDK: adaptive thinking, effort, strict tools, one prompt-cache breakpoint. */
export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic'
  readonly model: string
  readonly classifierModel: string
  private readonly client: Anthropic
  private readonly effort: Effort
  private readonly fallbacks: boolean
  private readonly stream: boolean
  private readonly cacheTail: 'always' | 'after-first'

  constructor(options: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      // retries are the agent loop's (rate-limit.ts): retry-after, backoff, a deadline and a "busy" step for the user
      maxRetries: 0,
    })
    this.model = options.model ?? DEFAULT_MODEL
    this.classifierModel = options.classifierModel ?? DEFAULT_CLASSIFIER_MODEL
    this.effort = options.effort ?? 'medium'
    this.fallbacks = options.fallbacks ?? true
    this.stream = options.stream ?? false
    this.cacheTail = options.cacheTail ?? 'after-first'
  }

  async classify(input: ClassifyInput, signal: AbortSignal): Promise<Classification> {
    const msg = await this.client.messages.create(
      {
        model: this.classifierModel,
        max_tokens: 1024,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: CLASSIFY_SCHEMA } },
        // stage 5 block 3: the fixed part (instructions + the app's context, the same for every request of a release)
        // sits in the system prompt under one cache breakpoint; only the request varies. The instructions alone are
        // above Haiku 5.5's 512-token minimum, so the classifier reads the fixed part from the cache after the first
        // request of an app
        system: [
          { type: 'text', text: CLASSIFIER_INSTRUCTIONS },
          { type: 'text', text: input.context, cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: `<request>\n${input.request}\n</request>` }],
      },
      { signal },
    )
    const usage = usageOf(msg.usage)
    if (msg.stop_reason === 'refusal') return { label: 'unclear', reason: '', usage, model: msg.model }
    const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
    try {
      const parsed = JSON.parse(text) as { label: Classification['label']; reason: string; question?: string; options?: string[]; intent_label?: string; gist?: string; backend_quote?: string }
      const backendQuote = parsed.label === 'needs-backend' && typeof parsed.backend_quote === 'string' && parsed.backend_quote.trim() ? parsed.backend_quote.trim().slice(0, 1000) : undefined
      return { label: parsed.label, reason: parsed.reason, ...clarifyOf(parsed), ...intentOf(parsed), ...(backendQuote ? { backendQuote } : {}), usage, model: msg.model }
    } catch {
      return { label: 'unclear', reason: '', usage, model: msg.model }
    }
  }

  get clusterModel(): string {
    return this.classifierModel
  }

  /** DECISIONS 75 Р2: the app's prompt counted with `count_tokens` (free) through this provider's client and key. */
  async countPromptTokens(manifest: PleatkitManifest): Promise<PromptTokenCount> {
    // imported here: prefix.ts imports this module for DEFAULT_MODEL
    const { countPromptTokens } = await import('../prefix.js')
    return countPromptTokens(manifest, { client: this.client, model: this.model })
  }

  /** C9: the wish-list map in one classifier call (structured output, low effort). */
  async cluster(input: ClusterInput, signal: AbortSignal): Promise<ClusterOutput> {
    const msg = await this.client.messages.create(
      {
        model: this.classifierModel,
        max_tokens: CLUSTER_MAX_TOKENS,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: CLUSTER_SCHEMA } },
        system: WISHES_INSTRUCTIONS,
        messages: [{ role: 'user', content: clusterMessage(input) }],
      },
      // the wish map is one call outside the agent loop: the SDK retries it
      { signal, maxRetries: 2 },
    )
    const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
    return { clusters: msg.stop_reason === 'refusal' ? [] : parseClusters(text), usage: usageOf(msg.usage), model: msg.model }
  }

  /**
   * One streamed call (`messages.stream` + `finalMessage()`). When it is cancelled, `onCancelled` gets what the stream
   * had reported: `message_start` carries the input and cache tokens; the output so far is estimated from the text
   * and tool-input deltas (~3.5 characters per token; thinking streams no text by default, so it is not counted).
   */
  private async streamed(params: Anthropic.Beta.MessageCreateParamsNonStreaming, options: TurnOptions): Promise<Anthropic.Beta.BetaMessage> {
    const sentAt = performance.now()
    const stream = this.client.beta.messages.stream(params, { signal: options.signal })
    let start: { usage: WireUsage; model: string; at: number } | null = null
    let chars = 0
    if (options.onCancelled) {
      stream.on('streamEvent', (event) => {
        if (event.type === 'message_start') start = { usage: event.message.usage, model: event.message.model, at: performance.now() }
        else if (event.type === 'content_block_delta') {
          const d = event.delta
          chars += d.type === 'text_delta' ? d.text.length : d.type === 'input_json_delta' ? d.partial_json.length : d.type === 'thinking_delta' ? d.thinking.length : 0
        }
      })
    }
    try {
      return await stream.finalMessage()
    } catch (e) {
      if (options.signal.aborted && options.onCancelled) {
        const now = performance.now()
        const s = start as { usage: WireUsage; model: string; at: number } | null
        const usage = s ? usageOf(s.usage) : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
        usage.outputTokens = Math.max(usage.outputTokens, Math.ceil(chars / 3.5))
        options.onCancelled({ model: s?.model ?? this.model, usage, started: s !== null, ms: Math.round(now - sentAt), generatingMs: s ? Math.round(now - s.at) : 0 })
      }
      throw e
    }
  }

  start(prompt: PromptParts, tools: ToolSpec[]): ModelSession {
    // screenshots go first, then the text that refers to them
    const first: MessageParam['content'] = prompt.images?.length
      ? [
          ...prompt.images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType, data: i.data } })),
          { type: 'text' as const, text: prompt.user },
        ]
      : prompt.user
    const messages: MessageParam[] = [{ role: 'user', content: first }]
    // Tools render first, then system; the single breakpoint on the last system block caches tools +
    // instructions + readonly sources + core types. The user message (dynamic files, request) varies.
    const system: Anthropic.Beta.BetaTextBlockParam[] = [
      { type: 'text', text: prompt.instructions },
      { type: 'text', text: prompt.cached, cache_control: { type: 'ephemeral' } },
    ]
    const toolDefs: Anthropic.Beta.BetaTool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
      strict: true,
      ...(this.stream ? { eager_input_streaming: true } : {}),
    }))
    let pendingText: string | null = null

    return {
      say: (text) => {
        pendingText = text
      },
      next: async (results: ToolResult[], options: TurnOptions): Promise<ModelTurn> => {
        const content: Anthropic.Beta.BetaContentBlockParam[] = results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: r.content,
          ...(r.ok ? {} : { is_error: true }),
        }))
        const pending = pendingText
        if (pendingText) content.push({ type: 'text', text: pendingText })
        pendingText = null
        const length = messages.length
        if (content.length > 0) messages.push({ role: 'user', content })

        const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
            // automatic caching of the conversation tail (brainstorm 04 §0.1): every turn re-reads the dynamic
            // files and the tool history from the cache instead of paying for them again; the explicit breakpoint
            // on the system block keeps tools + instructions + readonly sources cached across requests.
            // DECISIONS 76.1: with cacheTail 'after-first' the first call of an edit carries only the system
            // breakpoint (most edits take one call, and a cancelled early call then pays no tail write)
            ...(this.cacheTail === 'after-first' && messages.length === 1 ? {} : { cache_control: { type: 'ephemeral' as const } }),
            model: this.model,
            max_tokens: perCallMaxTokens(options.maxOutputTokens),
            thinking: { type: 'adaptive' },
            output_config: { effort: this.effort },
            system,
            tools: toolDefs,
            tool_choice: { type: 'auto' },
            messages,
            ...(this.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
        }
        // DECISIONS 74.1: a call the caller may cancel (the early call of the parallel classifier) streams, so a
        // cancel closes the stream and stops the generation; the tools stay as they are (eager input streaming only
        // with PLEATKIT_STREAM=1), so the cached prefix is the same for streamed and plain calls
        let msg: Anthropic.Beta.BetaMessage
        try {
          msg = this.stream || options.stream ? await this.streamed(params, options) : await this.client.beta.messages.create(params, { signal: options.signal })
        } catch (e) {
          // a failed call leaves the conversation as it was, so the loop can retry it (rate-limit.ts)
          messages.length = length
          pendingText = pending
          throw e
        }
        // Append the assistant turn unchanged (thinking blocks included): the harness stays append-only.
        messages.push({ role: 'assistant', content: msg.content as unknown as Anthropic.Beta.BetaContentBlockParam[] })

        const toolCalls = msg.content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }] : []))
        const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')
        const stop: ModelTurn['stop'] =
          msg.stop_reason === 'tool_use' ? 'tool_use' : msg.stop_reason === 'end_turn' ? 'end_turn' : msg.stop_reason === 'max_tokens' ? 'max_tokens' : msg.stop_reason === 'refusal' ? 'refusal' : 'other'
        return { text, toolCalls, stop, usage: usageOf(msg.usage), model: msg.model }
      },
    }
  }
}
