/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect raw JSON wire payloads */
import { describe, expect, it } from 'vitest'
import { runAgent } from '../src/loop.js'
import { AnthropicProvider } from '../src/providers/anthropic.js'
import { OpenAICompatibleProvider } from '../src/providers/openai.js'
import { CARD, GOOD_CARD, request } from './helpers.js'

interface Captured {
  url: string
  headers: Headers
  body: Record<string, any>
}

/** A fetch that records requests and replays canned JSON responses, so no test touches the network. */
function fakeFetch(responses: unknown[]): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) })
    const next = responses.shift()
    if (!next) return new Response(JSON.stringify({ error: 'no more canned responses' }), { status: 500 })
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } })
  }) as typeof fetch
  return { fetch: f, calls }
}

const message = (content: unknown[], stop_reason: string, usage: Record<string, number>, model = 'claude-sonnet-5-5') => ({
  id: 'msg_' + Math.random().toString(36).slice(2),
  type: 'message',
  role: 'assistant',
  model,
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
})

describe('AnthropicProvider (wire format, fake fetch)', () => {
  it('classifies with Haiku + structured output, then runs Sonnet with adaptive thinking, effort, strict tools and one cache breakpoint', async () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig-abc' }
    const { fetch, calls } = fakeFetch([
      message([{ type: 'text', text: JSON.stringify({ label: 'ui', reason: 'Display only.' }) }], 'end_turn', { input_tokens: 400, output_tokens: 30 }, 'claude-haiku-5-5'),
      message(
        [
          thinking,
          { type: 'tool_use', id: 'tu_1', name: 'write_file', input: { path: CARD, content: GOOD_CARD } },
          { type: 'tool_use', id: 'tu_2', name: 'check', input: {} },
        ],
        'tool_use',
        { input_tokens: 900, output_tokens: 700, cache_creation_input_tokens: 3000 },
      ),
      message([{ type: 'tool_use', id: 'tu_3', name: 'finish', input: { verdict: 'ok', summary: 'Phone added.' } }], 'tool_use', {
        input_tokens: 300,
        output_tokens: 80,
        cache_read_input_tokens: 3000,
      }),
    ])
    const provider = new AnthropicProvider({ apiKey: 'test-key', baseURL: 'http://anthropic.test', fetch })
    // the wire format in order: classifier, then the main model (the parallel start is tested in parallel-classifier.test.ts)
    const r = await runAgent(request('show the phone'), provider, { classifierMode: 'sequential' })

    expect(r.verdict).toBe('ok')
    expect(r.files[CARD]).toBe(GOOD_CARD)
    expect(calls).toHaveLength(3)

    const [cls, first, second] = calls as [Captured, Captured, Captured]
    expect(cls.body.model).toBe('claude-haiku-5-5')
    expect(cls.body.output_config.format.type).toBe('json_schema')
    expect(cls.body.output_config.effort).toBe('low')

    expect(first.body.model).toBe('claude-sonnet-5-5')
    expect(first.body.thinking).toEqual({ type: 'adaptive' })
    expect(first.body.output_config).toEqual({ effort: 'medium' })
    expect(first.body.tool_choice).toEqual({ type: 'auto' })
    expect(first.body.tools.map((t: { name: string }) => t.name)).toEqual(['list_files', 'read_file', 'write_file', 'edit_file', 'check', 'finish'])
    expect(first.body.tools.every((t: { strict: boolean; input_schema: { additionalProperties: boolean } }) => t.strict && t.input_schema.additionalProperties === false)).toBe(true)
    // DECISIONS 76.1: the first call of an edit carries only the system breakpoint (readonly sources + core types);
    // the tail (dynamic files) is written to the cache from the second call on (cacheTail 'after-first', the default)
    expect((JSON.stringify(first.body).match(/cache_control/g) ?? [])).toHaveLength(1)
    expect(first.body.cache_control).toBeUndefined()
    expect((JSON.stringify(second.body).match(/cache_control/g) ?? [])).toHaveLength(2)
    expect(second.body.cache_control).toEqual({ type: 'ephemeral' })
    expect(first.body.tools.some((t: { eager_input_streaming?: boolean }) => t.eager_input_streaming)).toBe(false)
    // block 6 (17 §21): the system prefix is cached for an hour by default; the tail stays 5-minute
    expect(first.body.system[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(first.body.system[1].text).toContain('<readonly_sources>')
    expect(first.body.messages[0].content).toContain('<user_request>')
    expect(first.body.fallbacks).toBe('default')
    expect(first.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01')

    // append-only: the assistant turn (with its thinking block) goes back unchanged, then all tool results in one user message
    expect(second.body.messages[1]).toEqual({ role: 'assistant', content: [thinking, expect.objectContaining({ id: 'tu_1' }), expect.objectContaining({ id: 'tu_2' })] })
    expect(second.body.messages[2].role).toBe('user')
    expect(second.body.messages[2].content.map((b: { tool_use_id: string }) => b.tool_use_id)).toEqual(['tu_1', 'tu_2'])
    expect(second.body.system).toEqual(first.body.system)

    const sonnet = r.usage.find((u) => u.model === 'claude-sonnet-5-5')!
    expect(sonnet).toMatchObject({ calls: 2, inputTokens: 1200, outputTokens: 780, cacheReadTokens: 3000, cacheWriteTokens: 3000 })
    // 1200*2 + 780*10 + 3000*0.2 + 3000*2.5 per million
    expect(sonnet.costUsd).toBeCloseTo((1200 * 2 + 780 * 10 + 3000 * 0.2 + 3000 * 2.5) / 1e6, 10)
    expect(r.usage.find((u) => u.model === 'claude-haiku-5-5')?.costUsd).toBeCloseTo((400 * 0.1 + 30 * 0.5) / 1e6, 12)
  })

  it('can turn the refusal fallback off, and maps a refusal to a failed run', async () => {
    const { fetch, calls } = fakeFetch([message([], 'refusal', { input_tokens: 10 })])
    const provider = new AnthropicProvider({ apiKey: 'k', baseURL: 'http://anthropic.test', fetch, fallbacks: false })
    const r = await runAgent(request('x'), provider, { classify: false })
    expect(calls[0]!.body.fallbacks).toBeUndefined()
    expect(r).toMatchObject({ verdict: 'failed', stopReason: 'refusal' })
  })
})

describe('OpenAICompatibleProvider (fake fetch)', () => {
  it('sends strict function tools and tool results as tool messages', async () => {
    const choice = (message: unknown, finish_reason: string) => ({ model: 'gpt-test', choices: [{ message, finish_reason }], usage: { prompt_tokens: 100, completion_tokens: 20 } })
    const { fetch, calls } = fakeFetch([
      choice({ role: 'assistant', content: '{"label":"ui","reason":"ok"}' }, 'stop'),
      choice(
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: CARD, content: GOOD_CARD }) } }] },
        'tool_calls',
      ),
      choice({ role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'finish', arguments: '{"verdict":"ok","summary":"Done."}' } }] }, 'tool_calls'),
    ])
    const provider = new OpenAICompatibleProvider({ apiKey: 'k', baseURL: 'http://openai.test/v1', model: 'gpt-test', fetch })
    const r = await runAgent(request('phone'), provider, { classifierMode: 'sequential' })
    expect(r.verdict).toBe('ok')
    expect(calls[1]!.url).toBe('http://openai.test/v1/chat/completions')
    expect(calls[1]!.headers.get('authorization')).toBe('Bearer k')
    expect(calls[1]!.body.tools[0].function.strict).toBe(true)
    const toolMsg = calls[2]!.body.messages.find((m: { role: string }) => m.role === 'tool')
    expect(toolMsg.tool_call_id).toBe('c1')
    expect(r.usage[0]).toMatchObject({ model: 'gpt-test', costUsd: null })
  })
})

/** An SSE body that sends `events`, then stays open until the request is aborted (a model still generating). */
function hangingStream(events: unknown[], signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`))
      signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
    },
  })
}

describe('DECISIONS 74.1: the early call streams, so a cancel bills only what was generated', () => {
  it('streams the early call with the same tools, cancels it when the classifier answers alone, and meters what message_start reported', async () => {
    const bodies: Record<string, any>[] = []
    const f = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      bodies.push(body)
      if (body.model === 'claude-haiku-5-5') {
        // the classifier answers after the main call has started streaming
        await new Promise((r) => setTimeout(r, 80))
        return new Response(JSON.stringify(message([{ type: 'text', text: JSON.stringify({ label: 'needs-backend', reason: 'Needs the server.', gist: 'store a new field', intent_label: 'backend-field' }) }], 'end_turn', { input_tokens: 300, output_tokens: 40 }, 'claude-haiku-5-5')), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const start = { type: 'message_start', message: { ...message([], null as unknown as string, { input_tokens: 1200, output_tokens: 2, cache_read_input_tokens: 7000, cache_creation_input_tokens: 0 }), stop_reason: null } }
      const events = [start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x'.repeat(70) } }]
      return new Response(hangingStream(events, init?.signal), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    const provider = new AnthropicProvider({ apiKey: 'k', baseURL: 'http://anthropic.test', fetch: f })
    const r = await runAgent(request('add a last-login field the server records'), provider)

    expect(r.verdict).toBe('needs-backend')
    const main = bodies.find((b) => b.model === 'claude-sonnet-5-5')!
    expect(main.stream).toBe(true)
    // the tool definitions are the plain ones (no eager input streaming without PLEATKIT_STREAM): same cached prefix
    expect(main.tools.some((t: { eager_input_streaming?: boolean }) => t.eager_input_streaming)).toBe(false)
    expect(r.cancelledCall).toMatchObject({ model: 'claude-sonnet-5-5', started: true, usage: { inputTokens: 1200, cacheReadTokens: 7000, outputTokens: 20 } })
    const sonnet = r.usage.find((u) => u.model === 'claude-sonnet-5-5')!
    expect(sonnet.costUsd).toBeCloseTo((1200 * 2 + 20 * 10 + 7000 * 0.2) / 1e6, 10)
    expect(r.modelCalls).toBe(0)
  })

  it('a cancel before message_start reports started: false and meters nothing', async () => {
    const f = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (body.model === 'claude-haiku-5-5') {
        await new Promise((r) => setTimeout(r, 30))
        return new Response(JSON.stringify(message([{ type: 'text', text: JSON.stringify({ label: 'off-topic', reason: 'Not about the app.' }) }], 'end_turn', { input_tokens: 100, output_tokens: 10 }, 'claude-haiku-5-5')), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(hangingStream([], init?.signal), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    const provider = new AnthropicProvider({ apiKey: 'k', baseURL: 'http://anthropic.test', fetch: f })
    const r = await runAgent(request('write me a poem'), provider)
    expect(r.verdict).toBe('refused')
    expect(r.cancelledCall).toMatchObject({ started: false })
    expect(r.usage.map((u) => u.model)).toEqual(['claude-haiku-5-5'])
  })
})
