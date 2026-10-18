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
    // two cache points: the block holding readonly sources + core types, and the automatic tail (04 §0.1)
    const breakpoints = JSON.stringify(first.body).match(/cache_control/g) ?? []
    expect(breakpoints).toHaveLength(2)
    expect(first.body.cache_control).toEqual({ type: 'ephemeral' })
    expect(first.body.tools.some((t: { eager_input_streaming?: boolean }) => t.eager_input_streaming)).toBe(false)
    expect(first.body.system[1].cache_control).toEqual({ type: 'ephemeral' })
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
