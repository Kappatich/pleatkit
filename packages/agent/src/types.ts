import type { AgentImage, RequestClass, TokenUsage } from '@pleatkit/runtime/compiler'
import type { ClusterInput, ClusterOutput } from './wishes.js'

/** JSON schema of a tool's input. Every tool is strict: all properties required, no extra ones. */
export interface ToolSpec {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required: string[]
    additionalProperties: false
  }
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  id: string
  ok: boolean
  /** Text returned to the model. */
  content: string
}

export interface ModelTurn {
  /** Assistant text, if any (shown as progress). */
  text: string
  toolCalls: ToolCall[]
  /** Why the model stopped this turn. */
  stop: 'tool_use' | 'end_turn' | 'max_tokens' | 'refusal' | 'other'
  usage: TokenUsage
  model: string
}

/** Prompt parts. `cached` is stable across requests (system rules, readonly sources, core types). */
export interface PromptParts {
  instructions: string
  cached: string
  /** First user message: the request, current dynamic files, target panel. */
  user: string
  /** Screenshots for the first user message (vision input), before its text. */
  images?: AgentImage[]
}

export interface TurnOptions {
  signal: AbortSignal
  /** Visible output tokens still allowed for this edit (thinking is not counted). */
  maxOutputTokens: number
  /**
   * DECISIONS 74.1: stream this call even when the provider does not stream by default (the main model's early call,
   * which the parallel classifier may cancel: a cancelled stream stops generating, so only what was generated is billed).
   */
  stream?: boolean
  /**
   * A streamed call that was cancelled: what it used before the cancel, as far as the stream told (input and cache
   * tokens from `message_start`; output estimated from the deltas received, thinking not visible), or `started: false`
   * when the cancel came before `message_start`.
   */
  onCancelled?: (info: CancelledCall) => void
}

/** What a cancelled streamed call used (DECISIONS 74.1). */
export interface CancelledCall {
  model: string
  usage: TokenUsage
  /** Did `message_start` arrive before the cancel? Without it the stream reported nothing. */
  started: boolean
  /** Milliseconds from the request to the cancel, and from `message_start` to the cancel (0 when not started). */
  ms: number
  generatingMs: number
}

/**
 * One conversation with a model. The provider owns the native message history, so provider-specific
 * blocks (e.g. Anthropic thinking blocks) are passed back unchanged.
 */
export interface ModelSession {
  next(results: ToolResult[], options: TurnOptions): Promise<ModelTurn>
  /** Append a plain user message (used once to nudge a model that stopped without calling finish). */
  say(text: string): void
}

export interface Classification {
  label: RequestClass
  reason: string
  /** For `unclear`: one question that would settle it, and 2 to 4 short answers. */
  question?: string
  options?: string[]
  /** DECISIONS 44: one of the closed list of request labels, and at most 12 words without names or numbers. */
  intentLabel?: string
  gist?: string
  usage: TokenUsage | null
  model: string | null
}

export interface ClassifyInput {
  request: string
  /** Short description of what the dynamic zone covers and which data exists. */
  context: string
}

export interface ModelProvider {
  readonly name: 'anthropic' | 'openai-compatible' | 'scripted' | (string & {})
  readonly model: string
  classify(input: ClassifyInput, signal: AbortSignal): Promise<Classification>
  /** C9: group the week's unserved requests into themes, one classifier call (the wish-list map). Optional. */
  cluster?(input: ClusterInput, signal: AbortSignal): Promise<ClusterOutput>
  /** The model `cluster` calls, so its cost can be estimated before the call (DECISIONS 70.3). */
  readonly clusterModel?: string
  start(prompt: PromptParts, tools: ToolSpec[], meta: { request: string }): ModelSession
}
