import { describe, expect, it } from 'vitest'
import { serializeDom, type DomLike } from '@morphkit/runtime'
import { callAgent } from '../src/sse.js'

const enc = new TextEncoder()
const result = { verdict: 'ok', summary: 'Done', files: {}, deleted: [], log: [], classification: null, provider: 'p', model: 'm', usage: [], modelCalls: 1, timings: { totalMs: 1, classifyMs: null, modelMs: 1, toolsMs: 0 }, requestId: null }

/** What a buffering proxy does to an SSE body: arbitrary re-chunking, here 7 bytes at a time. */
function proxied(text: string, size = 7): ReadableStream<Uint8Array> {
  const bytes = enc.encode(text)
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size))
      c.close()
    },
  })
}

const respond = (body: string, status = 200) => new Response(proxied(body), { status, headers: { 'content-type': 'text/event-stream' } })

describe('code review 06 §2 test 8: SSE through a buffering proxy', () => {
  it('keepalive comments, events split anywhere and a mangled progress event: the result still arrives', async () => {
    const body = [
      ': keepalive\n\n',
      'event: progress\ndata: {"type":"status","text":"Understanding"}\n\n',
      ': keepalive\n\n',
      'event: progress\ndata: {"type":"status","te\n\n', // cut by a proxy: skipped, not a SyntaxError
      `event: result\ndata: ${JSON.stringify(result)}\n\n`,
    ].join('')
    const seen: string[] = []
    const r = await callAgent('/agent', {} as never, (p) => seen.push('text' in p ? p.text : ''), { fetch: async () => respond(body) })
    expect(r.summary).toBe('Done')
    expect(seen).toEqual(['Understanding'])
  })

  it('a mangled result is an error the chat can show, not a crash', async () => {
    await expect(callAgent('/agent', {} as never, () => undefined, { fetch: async () => respond('event: result\ndata: {"verdict":\n\n') })).rejects.toThrow(/could not be read/)
  })

  it('cancel aborts the request', async () => {
    const abort = new AbortController()
    const hang: typeof fetch = (_u, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    const p = callAgent('/agent', {} as never, () => undefined, { fetch: hang, signal: abort.signal })
    abort.abort()
    await expect(p).rejects.toThrow(/abort/i)
  })

  it('a 401 gets one retry with a fresh token (brainstorm 05 #19)', async () => {
    const auth: string[] = []
    const f: typeof fetch = async (_u, init) => {
      const a = new Headers(init?.headers).get('authorization') ?? ''
      auth.push(a)
      return a === 'Bearer fresh' ? respond(`event: result\ndata: ${JSON.stringify(result)}\n\n`) : new Response('{"error":"token expired"}', { status: 401 })
    }
    const r = await callAgent('/agent', {} as never, () => undefined, { fetch: f, headers: { authorization: 'Bearer old' }, onAuthExpired: () => 'fresh' })
    expect(r.verdict).toBe('ok')
    expect(auth).toEqual(['Bearer old', 'Bearer fresh'])
  })
})

/** A tiny DOM stand-in: elements with attributes and children, text nodes. */
const el = (tag: string, attrs: Record<string, string>, ...children: DomLike[]): DomLike => ({
  nodeType: 1,
  tagName: tag.toUpperCase(),
  textContent: null,
  attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
  childNodes: children,
  hasAttribute: (n: string) => n in attrs,
})
const text = (t: string): DomLike => ({ nodeType: 3, textContent: t, childNodes: [] })

describe('brainstorm 05 #3: what the agent sees of a panel', () => {
  const panel = el(
    'div',
    {},
    el('div', { class: 'card', 'data-testid': 'customer-card', title: 'Globex Corp' }, text('Globex Corp'), el('a', { href: 'https://globex.example/u/123' }, text('site'))),
    el('p', { class: 'contact' }, text('ceo@globex.example, +1 (555) 010-2222')),
    el('section', { 'data-morphkit-private': '' }, text('SSN 123-45-6789')),
    el('input', { type: 'text', value: 'secret' }),
  )
  it('sends structure only by default: no names, no values, no private subtree', () => {
    const dom = serializeDom(panel)
    expect(dom).toContain('data-testid="customer-card"')
    expect(dom).toContain('[text:11]')
    expect(dom).not.toMatch(/Globex|ceo@|555|123-45|secret|globex\.example/)
    expect(dom).toContain('<section data-morphkit-private>[private]</section>')
  })
  it('with sendDomText, sends text with e-mails and numbers masked, still not the private part', () => {
    const dom = serializeDom(panel, { includeText: true })
    expect(dom).toContain('Globex Corp')
    expect(dom).toContain('[email]')
    expect(dom).toContain('[number]')
    expect(dom).not.toMatch(/ceo@|010-2222|123-45|secret|globex\.example/)
  })
})
