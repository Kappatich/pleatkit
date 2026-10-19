// Wire protocol between the browser (@pleatkit/ui) and the agent server (@pleatkit/agent).
// Types and a few constants, so both sides agree without the browser depending on Node code.

import type { FileMap, PleatkitManifest } from './types.js'

/**
 * `clarify`: the request was ambiguous; the result carries one question with options, nothing was changed.
 * `refused`: not run at all, with a fixed reply (`refusal` says why: off-topic request, quota, kill switch).
 */
export type AgentVerdict = 'ok' | 'partial' | 'needs-backend' | 'not-editable' | 'declined' | 'failed' | 'clarify' | 'refused'

/**
 * `partial`: the UI part is done and applied; what is left needs the backend (`backendNote`, for the admin).
 * `not-editable`: the request is about a part of the screen that is not open for edits (core, not backend).
 * `declined`: the agent will not do it (harmful, deceptive or against the app's rules); nothing changed.
 * Verdicts whose files are applied:
 */
export const APPLY_VERDICTS: readonly AgentVerdict[] = ['ok', 'partial']
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

/**
 * What the compiler needs to resolve imports exactly like the browser does, plus the app instance namespace
 * (V1 B6) and the app's runtime CSS input, for server compiles (V1 B1). `allowedHosts` (DECISIONS 63.1) is set only
 * by the agent server from its own manifest (`trustedInput`); the same field in a request body is ignored.
 */
export type CompileContextWire = Pick<PleatkitManifest, 'alias' | 'externals' | 'externalPatterns' | 'dynamicRoots' | 'css' | 'allowedHosts'> & { namespace?: string }

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
  /** compile: 'server' (V1 B1): compile, sign and store the resulting snapshot at the end of the run. */
  compile?: boolean
  /**
   * The head the request was made from (code review 06 item 6). The result echoes it; the browser commits only
   * if the head is still this snapshot. `null`: no edits yet.
   */
  expectedHeadId?: string | null
  /**
   * Take back one earlier edit while keeping the later ones (brainstorm 05 #13): the edit's files before and
   * after it; the agent reverses that change on the current files.
   */
  revert?: { snapshotId: string; message: string; before: FileMap; after: FileMap }
  /** Set when asking the agent to carry the user's edits over to a new app release (stale snapshot). */
  migration?: {
    /** Base files the user's edits were made against. */
    oldBase: FileMap
    /** The user's edited files (the stale head). */
    edited: FileMap
  }
}

export type ToolName = 'list_files' | 'read_file' | 'write_file' | 'edit_file' | 'check' | 'finish'

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
  /**
   * `overlapMs` (DECISIONS 73.3): how long the main model's first call ran while the classifier was still deciding;
   * the classifier and the main model start together, so this is the time the parallel start saved on an edit.
   * `classifierMode` (DECISIONS 75 Р5): how the classifier ran, when it ran; with PLEATKIT_CLASSIFIER=auto the
   * agent server picks it per app from the week's share of requests the classifier answered alone.
   */
  timings: { totalMs: number; classifyMs: number | null; modelMs: number; toolsMs: number; overlapMs?: number; classifierMode?: 'parallel' | 'sequential' }
  /**
   * DECISIONS 74.1: the main model's early call that the classifier made unnecessary, cancelled while streaming. Its
   * usage is in `usage` too (input and cache tokens as `message_start` reported them, output estimated from what had
   * streamed); `started: false` when the cancel came before the stream said anything.
   */
  cancelledCall?: { model: string; started: boolean; ms: number; generatingMs: number; usage: TokenUsage }
  /** Request id in store-server, when the agent server logs to one. */
  requestId: string | null
  /** Why the run stopped early (limits), if it did. `cost`: the per-edit dollar limit of the app's plan. */
  stopReason?: 'calls' | 'timeout' | 'output-tokens' | 'cost' | 'refusal' | 'no-finish' | 'error' | 'rate-limited'
  /**
   * Stage 5 block 3: the model provider kept refusing with 429 / overloaded after the retries (or a retry would not have
   * ended before the run's deadline). The verdict is `failed` and nothing was changed.
   */
  rateLimited?: boolean
  /** For verdict `refused`. */
  refusal?: AgentRefusal
  /** compile: 'server': the signed bundle of the resulting snapshot, ready under the bundle URL (V1 B1). */
  bundle?: { key: string; filesHash: string; compileMs: number }
  /** Version of the agent's instructions (F4). */
  promptVersion?: string
  /** Technical error behind a failed run (for the admin's log; the user only sees `summary`). */
  error?: string
  /** Echo of the request's `expectedHeadId`: commit only on top of this head. */
  expectedHeadId?: string | null
  /** For `partial` (and `needs-backend` from the main loop): what the backend would need, for the admin's wishlist. */
  backendNote?: string
  /**
   * Block 4: the verbatim part(s) of the user's request that need the backend (always a substring of the request, so
   * the drawer can show «Sent to your admin: "…"»). On a partial or needs-backend answer; absent otherwise.
   */
  backendQuote?: string
  /** Closed-list label of the request (brainstorm 12 A2), from the classifier; L1 facts use it, never the text. */
  intentLabel?: string
  /** At most 12 words of what was asked, without names or numbers (L0, for the wishlist map). */
  gist?: string
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
