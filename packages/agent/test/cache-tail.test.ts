/* eslint-disable @typescript-eslint/no-explicit-any -- the test inspects raw JSON wire payloads */
import { describe, expect, it } from 'vitest'
import { configFromEnv } from '../src/config.js'
import { runAgent } from '../src/loop.js'
import { AnthropicProvider } from '../src/providers/anthropic.js'
import { CARD, GOOD_CARD, request } from './helpers.js'

const message = (content: unknown[], usage: Record<string, number> = {}) => ({
  id: 'msg_x',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  content,
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
})

function fakeFetch(responses: unknown[]) {
  const bodies: Record<string, any>[] = []
  const f = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')))
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fetch: f, bodies }
}

describe('DECISIONS 76.1: where the first call puts its cache breakpoints', () => {
  const turns = () => [
    message([{ type: 'tool_use', id: 't1', name: 'write_file', input: { path: CARD, content: GOOD_CARD } }]),
    message([{ type: 'tool_use', id: 't2', name: 'finish', input: { verdict: 'ok', summary: 'Done.' } }]),
  ]

  it('after-first (the default): the first call carries only the system breakpoint, later calls the tail too', async () => {
    const { fetch, bodies } = fakeFetch(turns())
    const r = await runAgent(request('show the phone'), new AnthropicProvider({ apiKey: 'k', baseURL: 'http://anthropic.test', fetch }), { classify: false })
    expect(r.verdict).toBe('ok')
    expect(bodies[0]!.cache_control).toBeUndefined()
    expect(bodies[0]!.system[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(bodies[1]!.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('always: every call writes the conversation tail', async () => {
    const { fetch, bodies } = fakeFetch(turns())
    const provider = new AnthropicProvider({ apiKey: 'k', baseURL: 'http://anthropic.test', fetch, cacheTail: 'always' })
    const r = await runAgent(request('show the phone'), provider, { classify: false })
    expect(r.verdict).toBe('ok')
    expect(bodies.map((b) => b.cache_control)).toEqual([{ type: 'ephemeral' }, { type: 'ephemeral' }])
  })

  it('PLEATKIT_CACHE_TAIL selects it', () => {
    const p = configFromEnv({ PLEATKIT_API_KEY: 'k', PLEATKIT_CACHE_TAIL: 'always' }).provider as unknown as { cacheTail: string }
    expect(p.cacheTail).toBe('always')
    expect((configFromEnv({ PLEATKIT_API_KEY: 'k' }).provider as unknown as { cacheTail: string }).cacheTail).toBe('after-first')
  })
})
