import Anthropic from '@anthropic-ai/sdk'
import type { TokenUsage } from '@morphkit/runtime/compiler'
import { CLASSIFIER_INSTRUCTIONS } from '../prompt.js'
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
   * on Anthropic's recommended fallback model inside the same call. On by default; MORPHKIT_FALLBACKS=off disables it.
   */
  fallbacks?: boolean
  /** For tests: a fetch that never reaches the network. */
  fetch?: typeof fetch
}

export const DEFAULT_MODEL = 'claude-sonnet-5-5'
/**
 * max_tokens of one call caps thinking plus visible output together, so it stays generous: the edit's budget
 * of visible tokens is enforced by the loop between calls (DECISIONS item 11). 16k keeps non-streaming calls
 * well inside the SDK's request-time limits.
 */
export const MAX_TOKENS_PER_CALL = 16_000
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
    label: { type: 'string', enum: ['ui', 'needs-backend', 'unclear'] },
    reason: { type: 'string' },
  },
  required: ['label', 'reason'],
  additionalProperties: false,
} as const

/** Claude through the official SDK: adaptive thinking, effort, strict tools, one prompt-cache breakpoint. */
export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic'
  readonly model: string
  readonly classifierModel: string
  private readonly client: Anthropic
  private readonly effort: Effort
  private readonly fallbacks: boolean

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
      const parsed = JSON.parse(text) as { label: Classification['label']; reason: string }
      return { label: parsed.label, reason: parsed.reason, usage, model: msg.model }
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
    const toolDefs: Anthropic.Beta.BetaTool[] = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, strict: true }))
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

        const msg = await this.client.beta.messages.create(
          {
            model: this.model,
            max_tokens: MAX_TOKENS_PER_CALL,
            thinking: { type: 'adaptive' },
            output_config: { effort: this.effort },
            system,
            tools: toolDefs,
            tool_choice: { type: 'auto' },
            messages,
            ...(this.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
          },
          { signal: options.signal },
        )
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
