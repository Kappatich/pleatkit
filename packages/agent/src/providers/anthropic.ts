import Anthropic from '@anthropic-ai/sdk'
import type { TokenUsage } from '@pleatkit/runtime/compiler'
import { CLASSIFIER_INSTRUCTIONS, INTENT_LABELS } from '../prompt.js'
import { perCallMaxTokens } from './budget.js'
import type { Classification, ClassifyInput, ModelProvider, ModelSession, ModelTurn, PromptParts, ToolResult, ToolSpec, TurnOptions } from '../types.js'

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
    label: { type: 'string', enum: ['ui', 'needs-backend', 'unclear', 'off-topic'] },
    reason: { type: 'string' },
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
    intent_label: { type: 'string', enum: [...INTENT_LABELS] },
    gist: { type: 'string' },
  },
  required: ['label', 'reason', 'question', 'options', 'intent_label', 'gist'],
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

  constructor(options: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      maxRetries: 2,
    })
    this.model = options.model ?? DEFAULT_MODEL
    this.classifierModel = options.classifierModel ?? DEFAULT_CLASSIFIER_MODEL
    this.effort = options.effort ?? 'medium'
    this.fallbacks = options.fallbacks ?? true
    this.stream = options.stream ?? false
  }

  async classify(input: ClassifyInput, signal: AbortSignal): Promise<Classification> {
    const msg = await this.client.messages.create(
      {
        model: this.classifierModel,
        max_tokens: 1024,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: CLASSIFY_SCHEMA } },
        system: CLASSIFIER_INSTRUCTIONS,
        messages: [{ role: 'user', content: `${input.context}\n\n<request>\n${input.request}\n</request>` }],
      },
      { signal },
    )
    const usage = usageOf(msg.usage)
    if (msg.stop_reason === 'refusal') return { label: 'unclear', reason: '', usage, model: msg.model }
    const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
    try {
      const parsed = JSON.parse(text) as { label: Classification['label']; reason: string; question?: string; options?: string[]; intent_label?: string; gist?: string }
      return { label: parsed.label, reason: parsed.reason, ...clarifyOf(parsed), ...intentOf(parsed), usage, model: msg.model }
    } catch {
      return { label: 'unclear', reason: '', usage, model: msg.model }
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
        if (pendingText) content.push({ type: 'text', text: pendingText })
        pendingText = null
        if (content.length > 0) messages.push({ role: 'user', content })

        const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
            // automatic caching of the conversation tail (brainstorm 04 §0.1): every turn re-reads the dynamic
            // files and the tool history from the cache instead of paying for them again; the explicit breakpoint
            // on the system block keeps tools + instructions + readonly sources cached across requests
            cache_control: { type: 'ephemeral' },
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
        const msg = this.stream
          ? await this.client.beta.messages.stream(params, { signal: options.signal }).finalMessage()
          : await this.client.beta.messages.create(params, { signal: options.signal })
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
