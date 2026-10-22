import type { AgentImage, PleatkitManifest, RequestClass, TokenUsage } from '@pleatkit/runtime/compiler'
import type { PromptTokenCount } from './prefix.js'

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
  /** Block 4: for `needs-backend`, the verbatim part of the request that needs the server (a substring of it). */
  backendQuote?: string
  usage: TokenUsage | null
  model: string | null
  /**
   * Block 6 (DECISIONS 83): other calls this classification made (Jev's, a follow-up for the backend quote), metered
   * with the run. `usage`/`model` stay the classifier model's.
   */
  extraUsage?: { model: string; usage: TokenUsage }[]
  /** The classifier ensemble: who decided and what Jev said (AgentResult.classifier). */
  ensemble?: { decidedBy: 'jev' | 'model'; jev: { route: string; confidence: number; adversarial: number | null; ms: number } | null }
}

export interface ClassifyInput {
  request: string
  /** Short description of what the dynamic zone covers and which data exists. */
  context: string
  /**
   * Block 6: the classifier ensemble answers before the classifier model when Jev decides; the model's answer arrives
   * later and is passed here (its usage is metered and its intent label kept, if the run is still going).
   */
  onLate?: (c: Classification) => void
}

/** Block 6: the text parts of a needs-backend answer Jev decided alone (Jev writes no text). */
export interface BackendQuote {
  reason: string
  backendQuote?: string
  intentLabel?: string
  gist?: string
  usage: TokenUsage | null
  model: string | null
}

/** A structured JSON call (`ModelProvider.completeJson`). */
export interface JsonCall {
  /** What the call is for (a label in transcripts and logs). */
  name: string
  /** The system instructions. */
  instructions: string
  /** The user message. */
  message: string
  /** JSON schema of the answer: structured output where the provider supports it, JSON mode otherwise. */
  schema: Record<string, unknown>
  maxTokens: number
  /**
   * The answer of the `scripted` provider (tests and demos, no model): called with the loaded fixture files, whose
   * extra keys the caller may read. Without it the scripted provider answers `null`.
   */
  scripted?: (fixtures: readonly Record<string, unknown>[]) => unknown
}

export interface JsonOutput {
  /** The model's text (JSON when the call went well). */
  text: string
  usage: TokenUsage | null
  model: string | null
  /** The model refused to answer. */
  refused?: boolean
}

export interface ModelProvider {
  readonly name: 'anthropic' | 'openai-compatible' | 'scripted' | (string & {})
  readonly model: string
  classify(input: ClassifyInput, signal: AbortSignal): Promise<Classification>
  /**
   * One structured call outside the edit loop, on the classifier model: instructions, one user message, an answer as
   * JSON matching `call.schema`. The open agent makes no such call itself; agent server extensions do. Optional.
   */
  completeJson?(call: JsonCall, signal: AbortSignal): Promise<JsonOutput>
  /** The model `completeJson` (and the classifier) calls, so a caller can price a call before making it. */
  readonly classifierModel?: string
  /**
   * DECISIONS 75 Р2: the app's prompt counted by the provider's token counter (Anthropic's `count_tokens`, free), for
   * the expected cost of an edit on /admin. Optional: without it the agent server estimates from characters.
   */
  countPromptTokens?(manifest: PleatkitManifest): Promise<PromptTokenCount>
  /**
   * Block 6 (DECISIONS 83): for a request already routed to the server (by Jev), the user's sentence, the gist and the
   * verbatim part that needs the server, from the classifier model. Optional: without it the default sentence is used.
   */
  quoteBackend?(input: ClassifyInput, signal: AbortSignal): Promise<BackendQuote>
  start(prompt: PromptParts, tools: ToolSpec[], meta: { request: string }): ModelSession
}
