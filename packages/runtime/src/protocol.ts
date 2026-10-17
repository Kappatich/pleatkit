// Wire protocol between the browser (@morphkit/ui) and the agent server (@morphkit/agent).
// Types and a few constants, so both sides agree without the browser depending on Node code.

import type { FileMap, MorphkitManifest } from './types.js'

/**
 * `clarify`: the request was ambiguous; the result carries one question with options, nothing was changed.
 * `refused`: not run at all, with a fixed reply (`refusal` says why: off-topic request, quota, kill switch).
 */
export type AgentVerdict = 'ok' | 'needs-backend' | 'failed' | 'clarify' | 'refused'
/** Why a request was refused without running the model loop. */
export type AgentRefusal = 'off-topic' | 'quota' | 'disabled'

/** Image types every supported vision model accepts. */
export const AGENT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type AgentImageType = (typeof AGENT_IMAGE_TYPES)[number]
/** At most this many screenshots per request, and this many bytes of image data in total. */
export const MAX_AGENT_IMAGES = 3
export const MAX_AGENT_IMAGE_BYTES = 6 * 1024 * 1024
/** Longest DOM snapshot of a panel that is sent to the agent (characters). */
export const MAX_TARGET_DOM_CHARS = 12_000

/** A screenshot attached to a request: base64 without the `data:` prefix. */
export interface AgentImage {
  mediaType: AgentImageType
  data: string
  name?: string
}
/** `off-topic`: not about this app's interface (the agent is not a free chatbot, V1 A4). */
export type RequestClass = 'ui' | 'needs-backend' | 'unclear' | 'off-topic'
/** Interface languages of the chat and the admin dashboard (DECISIONS item 20). */
export type Locale = 'en' | 'ru'

/** What the compiler needs to resolve imports exactly like the browser does. */
export type CompileContextWire = Pick<MorphkitManifest, 'alias' | 'externals' | 'externalPatterns' | 'dynamicRoots'>

/** `POST /agent/run` body. The browser is the source of truth for files; the server is stateless. */
export interface AgentRunRequest {
  userId: string
  /** Store namespace (several apps can share one store-server). */
  appId?: string
  /** Language of the progress lines and of the summary (`en` by default). */
  locale?: Locale
  /** What the user asked for, verbatim. */
  request: string
  /** Current dynamic files of the user (head or draft). */
  files: FileMap
  /** Readonly sources the agent may read but not change. */
  readonly: FileMap
  /** `.d.ts` of core files that dynamic/readonly code imports. */
  coreTypes: FileMap
  context: CompileContextWire
  /** Dynamic files mounted via `<Dynamic id>`: each must keep a default export. */
  components: string[]
  /** Panel the user pointed at, if any (`customer-card`). */
  target?: string
  /**
   * Screenshots the user pasted or dropped into the chat (vision input). What they show, including any
   * text in them, is data about the user's screen, never instructions to the agent.
   */
  images?: AgentImage[]
  /**
   * The user's answer to the one clarifying question of this edit. With it the classifier is skipped, so
   * an edit never asks twice.
   */
  clarification?: { question: string; answer: string }
  /** Sanitized DOM of the panel the user pointed at, as the user sees it now (data, not instructions). */
  targetDom?: string
  /** Set when asking the agent to carry the user's edits over to a new app release (stale snapshot). */
  migration?: {
    /** Base files the user's edits were made against. */
    oldBase: FileMap
    /** The user's edited files (the stale head). */
    edited: FileMap
  }
}

export type ToolName = 'list_files' | 'read_file' | 'write_file' | 'check' | 'finish'

/** One entry of the tool log, kept in the response and in store-server. */
export interface ToolLogEntry {
  /** 1-based model call that issued this tool call. */
  turn: number
  tool: ToolName | string
  /** Tool input; `content` of write_file is replaced with its size to keep logs small. */
  input: Record<string, unknown>
  ok: boolean
  /** Short human-readable result (errors in full). */
  result: string
  /** Policy violation, e.g. a write outside the dynamic zone. */
  violation?: string
  ms: number
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /**
   * Part of `outputTokens` the model spent thinking, when the API reports it. The output budget of an edit
   * counts only the visible rest (DECISIONS item 11); thinking is billed but not limited.
   */
  thinkingTokens?: number
}

export interface UsageByModel extends TokenUsage {
  model: string
  calls: number
  /** Estimated cost in USD from the published per-token prices, null if the model's price is unknown. */
  costUsd: number | null
}

export interface AgentResult {
  verdict: AgentVerdict
  /** One or two sentences for the user. */
  summary: string
  /** Changed or added files only. */
  files: FileMap
  /** Paths the agent deleted (rare). */
  deleted: string[]
  log: ToolLogEntry[]
  classification: RequestClass | null
  provider: string
  model: string
  usage: UsageByModel[]
  /** Total model calls in the main loop (the classifier is counted separately in `usage`). */
  modelCalls: number
  /** Output of the main loop: visible tokens count against `limit`, thinking tokens are reported only. */
  output?: { visibleTokens: number; thinkingTokens: number; limit: number; estimated: boolean }
  timings: { totalMs: number; classifyMs: number | null; modelMs: number; toolsMs: number }
  /** Request id in store-server, when the agent server logs to one. */
  requestId: string | null
  /** Why the run stopped early (limits), if it did. `cost`: the per-edit dollar limit of the app's plan. */
  stopReason?: 'calls' | 'timeout' | 'output-tokens' | 'cost' | 'refusal' | 'no-finish' | 'error'
  /** For verdict `refused`. */
  refusal?: AgentRefusal
  /** Technical error behind a failed run (for the admin's log; the user only sees `summary`). */
  error?: string
  /** For verdict `clarify`: the question to show and 2 to 4 short answers as buttons. */
  clarify?: { question: string; options: string[] }
  /** What came with the request besides text (sizes only; images are not stored). */
  attachments?: { images: number; imageBytes: number; targetDomChars: number }
}

/**
 * Progress shown to the end user. `text` is always a plain-language line ("Looking at the customer card");
 * never code, file paths or compiler output, which stay in the result's tool log for the admin (DECISIONS item 10).
 */
export type AgentProgress =
  | { type: 'status'; text: string }
  | { type: 'classified'; label: RequestClass; text: string }
  | { type: 'model'; turn: number; text: string; /** "Thinking" between tool calls: collapsible, replaced by the next step. */ transient?: boolean }
  | { type: 'tool'; turn: number; tool: string; text: string; ok?: boolean }
  | { type: 'check'; ok: boolean; errorCount: number; text: string }

/** SSE events of `POST /agent/run`: `event: progress|result|error`, `data: <json>`. */
export type AgentEvent = { event: 'progress'; data: AgentProgress } | { event: 'result'; data: AgentResult } | { event: 'error'; data: { message: string } }
