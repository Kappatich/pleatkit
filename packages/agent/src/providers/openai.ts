import type { TokenUsage } from '@pleatkit/runtime/compiler'
import { perCallMaxTokens } from './budget.js'
import { CLASSIFIER_INSTRUCTIONS } from '../prompt.js'
import { clarifyOf } from './anthropic.js'
import type { Classification, ClassifyInput, ModelProvider, ModelSession, ModelTurn, PromptParts, ToolResult, ToolSpec, TurnOptions } from '../types.js'
import { clusterMessage, parseClusters, WISHES_INSTRUCTIONS, type ClusterInput, type ClusterOutput } from '../wishes.js'

export interface OpenAICompatibleOptions {
  apiKey: string
  /** e.g. https://api.openai.com/v1 or https://openrouter.ai/api/v1 */
  baseURL: string
  model: string
  classifierModel?: string
  /** Extra headers (OpenRouter's HTTP-Referer / X-Title). */
  headers?: Record<string, string>
  fetch?: typeof fetch
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
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  }
}

function usageOf(u: ChatResponse['usage']): TokenUsage {
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0
  const reasoning = u?.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: (u?.prompt_tokens ?? 0) - cached,
    outputTokens: u?.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    ...(typeof reasoning === 'number' ? { thinkingTokens: reasoning } : {}),
  }
}

/** Any OpenAI-compatible Chat Completions API (OpenAI, OpenRouter, ...), with strict function tools. */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = 'openai-compatible'
  readonly model: string
  private readonly classifierModel: string
  private readonly fetchFn: typeof fetch

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.model = options.model
    this.classifierModel = options.classifierModel ?? options.model
    this.fetchFn = options.fetch ?? ((...a) => globalThis.fetch(...a))
  }

  private async chat(body: Record<string, unknown>, signal: AbortSignal): Promise<ChatResponse> {
    const res = await this.fetchFn(`${this.options.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}`, ...this.options.headers },
      body: JSON.stringify(body),
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

  async classify(input: ClassifyInput, signal: AbortSignal): Promise<Classification> {
    const r = await this.chat(
      {
        model: this.classifierModel,
        messages: [
          { role: 'system', content: `${CLASSIFIER_INSTRUCTIONS}\nAnswer with JSON only: {"label": "...", "reason": "...", "question": "...", "options": ["..."]}` },
          { role: 'user', content: `${input.context}\n\n<request>\n${input.request}\n</request>` },
        ],
        response_format: { type: 'json_object' },
      },
      signal,
    )
    const text = textOf(r.choices[0]?.message.content)
    try {
      const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { label?: string; reason?: string; question?: string; options?: string[]; backend_quote?: string }
      const label = parsed.label === 'ui' || parsed.label === 'needs-backend' || parsed.label === 'off-topic' || parsed.label === 'restore' ? parsed.label : 'unclear'
      const backendQuote = label === 'needs-backend' && typeof parsed.backend_quote === 'string' && parsed.backend_quote.trim() ? parsed.backend_quote.trim().slice(0, 1000) : undefined
      return { label, reason: parsed.reason ?? '', ...(label === 'unclear' ? clarifyOf(parsed) : {}), ...(backendQuote ? { backendQuote } : {}), usage: usageOf(r.usage), model: r.model ?? this.classifierModel }
    } catch {
      return { label: 'unclear', reason: '', usage: usageOf(r.usage), model: r.model ?? this.classifierModel }
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
    return { clusters: parseClusters(textOf(r.choices[0]?.message.content)), usage: usageOf(r.usage), model: r.model ?? this.classifierModel }
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
    return {
      say: (text) => {
        pendingText = text
      },
      next: async (results: ToolResult[], options: TurnOptions): Promise<ModelTurn> => {
        const length = messages.length
        const pending = pendingText
        for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.ok ? r.content : `ERROR: ${r.content}` })
        if (pendingText) messages.push({ role: 'user', content: pendingText })
        pendingText = null
        let r: ChatResponse
        try {
          r = await this.chat({ model: this.model, messages, tools: toolDefs, tool_choice: 'auto', max_completion_tokens: perCallMaxTokens(options.maxOutputTokens) }, options.signal)
        } catch (e) {
          // a failed call leaves the conversation as it was, so the loop can retry it (rate-limit.ts)
          messages.length = length
          pendingText = pending
          throw e
        }
        const choice = r.choices[0]
        if (!choice) throw new Error('Model API returned no choices')
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
        return { text: textOf(choice.message.content), toolCalls, stop: stop === 'max_tokens' ? 'max_tokens' : toolCalls.length ? 'tool_use' : stop, usage: usageOf(r.usage), model: r.model ?? this.model }
      },
    }
  }
}
