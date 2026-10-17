import type { AgentProgress, AgentResult, AgentRunRequest } from '@morphkit/runtime'

export interface SseMessage {
  event: string
  data: string
}

/** Parse a `text/event-stream` body incrementally (EventSource cannot POST). */
export async function readSse(body: ReadableStream<Uint8Array>, onMessage: (m: SseMessage) => void): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const flush = (chunk: string) => {
    let event = 'message'
    const data: string[] = []
    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (data.length) onMessage({ event, data: data.join('\n') })
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let i: number
    while ((i = buffer.search(/\r?\n\r?\n/)) !== -1) {
      flush(buffer.slice(0, i))
      buffer = buffer.slice(i).replace(/^\r?\n\r?\n/, '')
    }
  }
  if (buffer.trim()) flush(buffer)
}

export class AgentRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentRequestError'
  }
}

/** JSON of one SSE event, or null when a proxy mangled it (code review 06 item 10: never a SyntaxError). */
function parseData<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T
  } catch {
    return null
  }
}

export interface CallAgentOptions {
  /** Cancels the run: the request is aborted, and the agent server stops the model (code review 06 item 5). */
  signal?: AbortSignal
  fetch?: typeof fetch
  headers?: Record<string, string>
  /** Called once when the agent server answers 401 (the user token expired): a fresh token, sent on the retry. */
  onAuthExpired?: () => string | null | undefined | Promise<string | null | undefined>
}

/** `POST <agentUrl>/run` and follow the SSE stream until the result. Keepalive comments are skipped. */
export async function callAgent(agentUrl: string, body: AgentRunRequest, onProgress: (p: AgentProgress) => void, options: CallAgentOptions = {}): Promise<AgentResult> {
  const f = options.fetch ?? ((...a) => globalThis.fetch(...a))
  const send = (headers: Record<string, string> = {}) =>
    f(`${agentUrl.replace(/\/$/, '')}/v1/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...options.headers, ...headers },
      body: JSON.stringify(body),
      signal: options.signal,
    })
  let res = await send()
  if (res.status === 401 && options.onAuthExpired) {
    // brainstorm 05 #19: the token expired mid-session; the same Idempotency-Key makes the retry safe
    const fresh = await options.onAuthExpired()
    if (fresh) res = await send({ authorization: `Bearer ${fresh}` })
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    let message = text
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text
    } catch {
      // not JSON
    }
    throw new AgentRequestError(`Agent server responded ${res.status}${message ? `: ${message}` : ''}`)
  }
  let result: AgentResult | null = null
  let error: string | null = null
  await readSse(res.body, (m) => {
    if (m.event === 'progress') {
      const p = parseData<AgentProgress>(m.data)
      if (p) onProgress(p)
    } else if (m.event === 'result') {
      result = parseData<AgentResult>(m.data)
      if (!result) error = 'The agent sent a result that could not be read'
    } else if (m.event === 'error') error = parseData<{ message: string }>(m.data)?.message ?? 'The agent reported an error'
  })
  if (error) throw new AgentRequestError(error)
  if (!result) throw new AgentRequestError('The agent closed the connection without a result')
  return result
}
