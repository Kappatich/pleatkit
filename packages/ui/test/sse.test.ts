import { describe, expect, it } from 'vitest'
import { callAgent, readSse } from '../src/sse.js'

const stream = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch))
      c.close()
    },
  })

describe('readSse', () => {
  it('parses events split across chunks, with CRLF and multi-line data', async () => {
    const got: { event: string; data: string }[] = []
    await readSse(stream(['event: progress\ndata: {"a"', ':1}\n\nevent: result\r\ndata: line1\r\ndata: line2\r\n\r\n', 'data: tail']), (m) => got.push(m))
    expect(got).toEqual([
      { event: 'progress', data: '{"a":1}' },
      { event: 'result', data: 'line1\nline2' },
      { event: 'message', data: 'tail' },
    ])
  })
})

describe('callAgent', () => {
  it('reports progress and returns the result', async () => {
    const body = 'event: progress\ndata: {"type":"status","text":"Thinking"}\n\nevent: result\ndata: {"verdict":"ok","files":{}}\n\n'
    const fetch = (async () => new Response(stream([body]), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof globalThis.fetch
    const seen: string[] = []
    const r = await callAgent('/agent', {} as never, (p) => seen.push(p.text), { fetch })
    expect(seen).toEqual(['Thinking'])
    expect(r.verdict).toBe('ok')
  })

  it('surfaces HTTP and stream errors', async () => {
    const bad = (async () => new Response(JSON.stringify({ error: 'request is required' }), { status: 400 })) as unknown as typeof globalThis.fetch
    await expect(callAgent('/agent', {} as never, () => undefined, { fetch: bad })).rejects.toThrow('400: request is required')
    const err = (async () => new Response(stream(['event: error\ndata: {"message":"boom"}\n\n']))) as unknown as typeof globalThis.fetch
    await expect(callAgent('/agent', {} as never, () => undefined, { fetch: err })).rejects.toThrow('boom')
  })
})
