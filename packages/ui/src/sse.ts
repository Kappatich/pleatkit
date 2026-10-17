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

/** `POST <agentUrl>/run` and follow the SSE stream until the result. */
export async function callAgent(
  agentUrl: string,
  body: AgentRunRequest,
  onProgress: (p: AgentProgress) => void,
  options: { signal?: AbortSignal; fetch?: typeof fetch; headers?: Record<string, string> } = {},
): Promise<AgentResult> {
  const f = options.fetch ?? ((...a) => globalThis.fetch(...a))
  const res = await f(`${agentUrl.replace(/\/$/, '')}/v1/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...options.headers },
    body: JSON.stringify(body),
    signal: options.signal,
  })
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
    if (m.event === 'progress') onProgress(JSON.parse(m.data) as AgentProgress)
    else if (m.event === 'result') result = JSON.parse(m.data) as AgentResult
    else if (m.event === 'error') error = (JSON.parse(m.data) as { message: string }).message
  })
  if (error) throw new AgentRequestError(error)
  if (!result) throw new AgentRequestError('The agent closed the connection without a result')
  return result
}
