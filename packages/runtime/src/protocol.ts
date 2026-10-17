// Wire protocol between the browser (@morphkit/ui) and the agent server (@morphkit/agent).
// Types only, so both sides agree without the browser depending on Node code.

import type { FileMap, MorphkitManifest } from './types.js'

export type AgentVerdict = 'ok' | 'needs-backend' | 'failed'
export type RequestClass = 'ui' | 'needs-backend' | 'unclear'

/** What the compiler needs to resolve imports exactly like the browser does. */
export type CompileContextWire = Pick<MorphkitManifest, 'alias' | 'externals' | 'externalPatterns' | 'dynamicRoots'>

/** `POST /agent/run` body. The browser is the source of truth for files; the server is stateless. */
export interface AgentRunRequest {
  userId: string
  /** Store namespace (several apps can share one store-server). */
  appId?: string
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
  timings: { totalMs: number; classifyMs: number | null; modelMs: number; toolsMs: number }
  /** Request id in store-server, when the agent server logs to one. */
  requestId: string | null
  /** Why the run stopped early (limits), if it did. */
  stopReason?: 'calls' | 'timeout' | 'output-tokens' | 'refusal' | 'no-finish' | 'error'
}

/**
 * Progress shown to the end user. `text` is always a plain-language line ("Looking at the customer card");
 * never code, file paths or compiler output, which stay in the result's tool log for the admin (DECISIONS item 10).
 */
export type AgentProgress =
  | { type: 'status'; text: string }
  | { type: 'classified'; label: RequestClass; text: string }
  | { type: 'model'; turn: number; text: string }
  | { type: 'tool'; turn: number; tool: string; text: string; ok?: boolean }
  | { type: 'check'; ok: boolean; errorCount: number; text: string }

/** SSE events of `POST /agent/run`: `event: progress|result|error`, `data: <json>`. */
export type AgentEvent = { event: 'progress'; data: AgentProgress } | { event: 'result'; data: AgentResult } | { event: 'error'; data: { message: string } }
