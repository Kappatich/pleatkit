import type { TokenUsage } from '@pleatkit/runtime/compiler'
import { perCallMaxTokens } from './budget.js'
import { CLASSIFIER_INSTRUCTIONS } from '../prompt.js'
import { CLASSIFY_SCHEMA, clarifyOf, intentOf } from './anthropic.js'
import type { Classification, ClassifyInput, ModelProvider, ModelSession, ModelTurn, PromptParts, ToolResult, ToolSpec, TurnOptions } from '../types.js'
import { clusterMessage, parseClusters, WISHES_INSTRUCTIONS, type ClusterInput, type ClusterOutput } from '../wishes.js'

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high'
export type OpenRouterSort = 'price' | 'throughput' | 'latency'

export interface OpenAICompatibleOptions {
  apiKey: string
  /** e.g. https://api.openai.com/v1 or https://openrouter.ai/api/v1 */
  baseURL: string
  model: string
  classifierModel?: string
  /** Extra headers; for OpenRouter they are added to its default `HTTP-Referer` and `X-Title`. */
  headers?: Record<string, string>
  /**
   * The output cap's field: `max_completion_tokens` (OpenAI's, the default) or `max_tokens` (the default for
   * OpenRouter, which every model behind it takes).
   */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /** Reasoning effort of the main model's calls; unset: the model's own default (nothing is sent). */
  reasoningEffort?: ReasoningEffort
  /**
   * Reasoning effort of the classifier's call. Default `low` on OpenRouter (as Haiku's classifier call runs at effort
   * low; OpenRouter drops it for a model without reasoning), unset elsewhere (a non-reasoning OpenAI model refuses it).
   */
  classifierReasoningEffort?: ReasoningEffort
  /** OpenRouter's behaviour (its headers, `max_tokens`, billed cost); default: from the base URL's host. */
  openRouter?: boolean
  /**
   * Stage 5 block 8: OpenRouter's host choice, sent as `provider: { sort }` on every call (`throughput`: the fastest
   * host in tokens per second, `latency`: the quickest first token, `price`: the cheapest). Unset: OpenRouter's default
   * routing. Ignored off OpenRouter.
   */
  providerSort?: OpenRouterSort
  fetch?: typeof fetch
}

/** OpenRouter's attribution headers (optional on its side; they name the app on openrouter.ai's usage pages). */
export const OPENROUTER_HEADERS: Readonly<Record<string, string>> = { 'HTTP-Referer': 'https://github.com/Kappatich/pleatkit', 'X-Title': 'pleatkit' }

/** True for an OpenRouter base URL (openrouter.ai or a subdomain). */
export function isOpenRouter(baseURL: string): boolean {
  try {
    const host = new URL(baseURL).hostname
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai')
  } catch {
    return false
  }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[]
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

/** Responses carry plain text; only requests use content parts (images). */
const textOf = (c: ChatMessage['content'] | undefined): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p.type === 'text' ? p.text : '')).join('') : ''

interface ChatResponse {
  model?: string
  choices: { message: ChatMessage; finish_reason: string | null }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    /** OpenRouter: what the call was billed, in USD (`usage: { include: true }`). */
    cost?: number
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  }
}

export function openAIUsageOf(u: ChatResponse['usage']): TokenUsage {
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0
  const written = u?.prompt_tokens_details?.cache_write_tokens ?? 0
  const reasoning = u?.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: Math.max(0, (u?.prompt_tokens ?? 0) - cached - written),
    outputTokens: u?.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: written,
    ...(typeof reasoning === 'number' ? { thinkingTokens: reasoning } : {}),
    ...(typeof u?.cost === 'number' && Number.isFinite(u.cost) ? { billedUsd: u.cost } : {}),
  }
}

/** The OpenAI message refuses a strict json_schema format (an older model or another vendor's endpoint). */
const refusesSchema = (e: unknown): boolean => {
  const err = e as { status?: number; message?: string }
  return err.status === 400 && /response_format|json_schema|structured/i.test(err.message ?? '')
}

/** Any OpenAI-compatible Chat Completions API (OpenAI, OpenRouter, ...), with strict function tools. */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = 'openai-compatible'
  readonly model: string
  readonly classifierModel: string
  readonly openRouter: boolean
  private readonly fetchFn: typeof fetch
  private readonly maxTokensField: 'max_tokens' | 'max_completion_tokens'
  private readonly classifierEffort: ReasoningEffort | undefined

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.model = options.model
    this.classifierModel = options.classifierModel ?? options.model
    this.fetchFn = options.fetch ?? ((...a) => globalThis.fetch(...a))
    this.openRouter = options.openRouter ?? isOpenRouter(options.baseURL)
    this.maxTokensField = options.maxTokensField ?? (this.openRouter ? 'max_tokens' : 'max_completion_tokens')
    this.classifierEffort = options.classifierReasoningEffort ?? (this.openRouter ? 'low' : undefined)
  }

  /** The effort as the endpoint takes it: OpenRouter's `reasoning` object, OpenAI's `reasoning_effort`. */
  private effortField(effort: ReasoningEffort | undefined): Record<string, unknown> {
    if (!effort) return {}
    return this.openRouter ? { reasoning: { effort } } : { reasoning_effort: effort }
  }

  private async chat(body: Record<string, unknown>, signal: AbortSignal): Promise<ChatResponse> {
    const res = await this.fetchFn(`${this.options.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}`, ...(this.openRouter ? OPENROUTER_HEADERS : {}), ...this.options.headers },
      // OpenRouter reports what each call was billed (usage.cost) when asked
      body: JSON.stringify(this.openRouter ? { ...body, usage: { include: true }, ...(this.options.providerSort ? { provider: { sort: this.options.providerSort } } : {}) } : body),
      signal,
    })
    if (!res.ok) {
      // status and headers go with the error: the agent loop retries 429/5xx after retry-after (rate-limit.ts)
      const err = new Error(`Model API ${res.status}: ${(await res.text()).slice(0, 500)}`) as Error & { status: number; headers: Headers }
      err.status = res.status
      err.headers = res.headers
      throw err
    }
    return (await res.json()) as ChatResponse
  }

  /**
   * Stage 5 block 7: the same schema and fields as the Anthropic classifier (intent label, gist, backend quote, the
   * clarifying question), so a cheap classifier through OpenRouter routes adversarial and mixed requests the same way.
   * The instructions and the app's context form the system prompt (the endpoints' automatic prefix cache reads it).
   */
  async classify(input: ClassifyInput, signal: AbortSignal): Promise<Classification> {
    const messages = [
      { role: 'system', content: `${CLASSIFIER_INSTRUCTIONS}\n\n${input.context}` },
      { role: 'user', content: `<request>\n${input.request}\n</request>` },
    ]
    const base = { model: this.classifierModel, messages, [this.maxTokensField]: 2048, ...this.effortField(this.classifierEffort) }
    let r: ChatResponse
    try {
      r = await this.chat({ ...base, response_format: { type: 'json_schema', json_schema: { name: 'classification', strict: true, schema: CLASSIFY_SCHEMA } } }, signal)
    } catch (e) {
      if (!refusesSchema(e)) throw e
      messages[0] = { role: 'system', content: `${messages[0]!.content}\nAnswer with JSON only, the keys: label, reason, question, options, intent_label, gist, backend_quote.` }
      r = await this.chat({ ...base, messages, response_format: { type: 'json_object' } }, signal)
    }
    const usage = openAIUsageOf(r.usage)
    const model = r.model ?? this.classifierModel
    const text = textOf(r.choices[0]?.message.content)
    try {
      const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { label?: string; reason?: string; question?: string; options?: string[]; backend_quote?: string; intent_label?: string; gist?: string }
      const label = parsed.label === 'ui' || parsed.label === 'needs-backend' || parsed.label === 'off-topic' || parsed.label === 'restore' ? parsed.label : 'unclear'
      const backendQuote = label === 'needs-backend' && typeof parsed.backend_quote === 'string' && parsed.backend_quote.trim() ? parsed.backend_quote.trim().slice(0, 1000) : undefined
      return { label, reason: typeof parsed.reason === 'string' ? parsed.reason : '', ...(label === 'unclear' ? clarifyOf(parsed) : {}), ...intentOf(parsed), ...(backendQuote ? { backendQuote } : {}), usage, model }
    } catch {
      return { label: 'unclear', reason: '', usage, model }
    }
  }

  get clusterModel(): string {
    return this.classifierModel
  }

  /** C9: the wish-list map in one classifier call (JSON mode). */
  async cluster(input: ClusterInput, signal: AbortSignal): Promise<ClusterOutput> {
    const r = await this.chat(
      {
        model: this.classifierModel,
        messages: [
          { role: 'system', content: WISHES_INSTRUCTIONS },
          { role: 'user', content: clusterMessage(input) },
        ],
        response_format: { type: 'json_object' },
      },
      signal,
    )
    return { clusters: parseClusters(textOf(r.choices[0]?.message.content)), usage: openAIUsageOf(r.usage), model: r.model ?? this.classifierModel }
  }

  start(prompt: PromptParts, tools: ToolSpec[]): ModelSession {
    const messages: ChatMessage[] = [
      { role: 'system', content: `${prompt.instructions}\n\n${prompt.cached}` },
      {
        role: 'user',
        content: prompt.images?.length
          ? [...prompt.images.map((i) => ({ type: 'image_url' as const, image_url: { url: `data:${i.mediaType};base64,${i.data}` } })), { type: 'text' as const, text: prompt.user }]
          : prompt.user,
      },
    ]
    const toolDefs = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema, strict: true } }))
    let pendingText: string | null = null
    // block 7: the loop says something only when the last reply had no tool call (or was cut off); OpenAI's models then
    // often answer with the finish JSON as text again, so the next call must call a tool (`tool_choice: required`)
    let mustCallTool = false
    return {
      say: (text) => {
        pendingText = text
        mustCallTool = true
      },
      next: async (results: ToolResult[], options: TurnOptions): Promise<ModelTurn> => {
        const length = messages.length
        const pending = pendingText
        const force = mustCallTool
        mustCallTool = false
        for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.ok ? r.content : `ERROR: ${r.content}` })
        if (pendingText) messages.push({ role: 'user', content: pendingText })
        pendingText = null
        let r: ChatResponse
        try {
          r = await this.chat({ model: this.model, messages, tools: toolDefs, tool_choice: force ? 'required' : 'auto', [this.maxTokensField]: perCallMaxTokens(options.maxOutputTokens), ...this.effortField(this.options.reasoningEffort) }, options.signal)
        } catch (e) {
          // a failed call leaves the conversation as it was, so the loop can retry it (rate-limit.ts)
          messages.length = length
          pendingText = pending
          mustCallTool = force
          throw e
        }
        const choice = r.choices?.[0]
        if (!choice) throw new Error('Model API returned no choices')
        // the whole assistant message goes back, with any reasoning details the endpoint attached (Gemini's thought
        // signatures must come back with its tool calls)
        messages.push(choice.message)
        const toolCalls = (choice.message.tool_calls ?? []).map((c) => {
          let input: Record<string, unknown> = {}
          try {
            input = JSON.parse(c.function.arguments || '{}') as Record<string, unknown>
          } catch {
            input = { __invalid_json: c.function.arguments }
          }
          return { id: c.id, name: c.function.name, input }
        })
        const f = choice.finish_reason
        const stop: ModelTurn['stop'] = f === 'tool_calls' ? 'tool_use' : f === 'stop' ? 'end_turn' : f === 'length' ? 'max_tokens' : f === 'content_filter' ? 'refusal' : 'other'
        // a cut-off reply stays max_tokens even with tool calls: the last one may be incomplete
        return { text: textOf(choice.message.content), toolCalls, stop: stop === 'max_tokens' ? 'max_tokens' : toolCalls.length ? 'tool_use' : stop, usage: openAIUsageOf(r.usage), model: r.model ?? this.model }
      },
    }
  }
}
