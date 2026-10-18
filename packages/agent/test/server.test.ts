/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect raw JSON wire payloads */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentResult } from '@pleatkit/runtime/compiler'
import { configFromEnv } from '../src/config.js'
import { createAgentApp } from '../src/server.js'
import { CARD, GOOD_CARD, request, scripted } from './helpers.js'

function parseSse(text: string): { event: string; data: any }[] {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? 'message'
      const data = chunk
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n')
      return { event, data: JSON.parse(data) }
    })
}

const provider = scripted({
  name: 'phone',
  turns: [
    { calls: [{ tool: 'write_file', input: { path: CARD, content: GOOD_CARD } }, { tool: 'check', input: {} }] },
    { calls: [{ tool: 'finish', input: { verdict: 'ok', summary: 'Added.' } }] },
  ],
})

afterEach(() => vi.restoreAllMocks())

describe('agent HTTP server', () => {
  it('streams progress events and the result over SSE', async () => {
    const app = createAgentApp({ provider, log: () => undefined })
    const res = await app.request('/agent/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request('phone')) })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const events = parseSse(await res.text())
    expect(events.filter((e) => e.event === 'progress').length).toBeGreaterThan(3)
    const result = events.at(-1)!
    expect(result.event).toBe('result')
    expect((result.data as AgentResult).verdict).toBe('ok')
    expect((result.data as AgentResult).requestId).toBeNull()
  })

  it('rejects malformed bodies with 400', async () => {
    const app = createAgentApp({ provider, log: () => undefined })
    const res = await app.request('/agent/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: 'x' }) })
    expect(res.status).toBe(400)
  })

  it('logs the run in store-server and returns its request id', async () => {
    const original = globalThis.fetch
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      if (url === 'http://store.test/v1/quota') return json({ ok: true, tokens: {} })
      if (url === 'http://store.test/v1/plan') return json({ plan: null, limits: {} })
      if (url.startsWith('http://store.test')) return json({ id: 'req_42' }, 201)
      return original(input, init)
    })
    const app = createAgentApp({ provider, storeUrl: 'http://store.test', log: () => undefined })
    const res = await app.request('/agent/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request('phone')) })
    const result = parseSse(await res.text()).at(-1)!.data as AgentResult
    expect(result.requestId).toBe('req_42')
    const [url, init] = spy.mock.calls.find(([u]) => String(u).endsWith('/requests'))!
    expect(url).toBe('http://store.test/v1/requests')
    const body = JSON.parse(String(init!.body))
    expect(body).toMatchObject({ userId: 'alice', text: 'phone', verdict: 'ok', status: 'proposed' })
    expect(body.log.length).toBe(3)
    expect(new Headers(init!.headers).get('x-pleatkit-app')).toBe('test')
  })

  it('health reports the provider', async () => {
    const res = await createAgentApp({ provider, log: () => undefined }).request('/agent/health')
    expect(await res.json()).toMatchObject({ ok: true, provider: 'scripted' })
  })
})

describe('pluggable runner (DECISIONS item 9)', () => {
  it('serves any AgentRunner, not only the built-in loop', async () => {
    const runner = {
      name: 'fake-harness',
      model: 'fake',
      run: async () => ({
        verdict: 'ok' as const, summary: 'Done.', files: {}, deleted: [], log: [], classification: null, provider: 'fake-harness', model: 'fake',
        usage: [], modelCalls: 0, timings: { totalMs: 0, classifyMs: null, modelMs: 0, toolsMs: 0 },
      }),
    }
    const app = createAgentApp({ runner, log: () => undefined })
    expect(await (await app.request('/agent/health')).json()).toMatchObject({ provider: 'fake-harness' })
    const res = await app.request('/agent/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request('x')) })
    expect(parseSse(await res.text()).at(-1)!.data.summary).toBe('Done.')
  })
})

describe('configFromEnv', () => {
  it('defaults to the scripted provider without a key, even if ANTHROPIC_API_KEY is set for other tools', () => {
    expect(configFromEnv({ ANTHROPIC_API_KEY: 'x' }).provider.name).toBe('scripted')
  })
  it('uses Anthropic with Sonnet 5.5 + Haiku 5.5 when PLEATKIT_API_KEY is set', () => {
    const c = configFromEnv({ PLEATKIT_API_KEY: 'x', PLEATKIT_AGENT_PORT: '9999', PLEATKIT_MAX_CALLS: '5' })
    expect(c.provider.name).toBe('anthropic')
    expect(c.provider.model).toBe('claude-sonnet-5-5')
    expect((c.provider as unknown as { classifierModel: string }).classifierModel).toBe('claude-haiku-5-5')
    expect(c.port).toBe(9999)
    expect(c.limits.maxModelCalls).toBe(5)
  })
  it('openai-compatible needs a model and takes the base URL', () => {
    expect(() => configFromEnv({ PLEATKIT_PROVIDER: 'openai-compatible', PLEATKIT_API_KEY: 'x' })).toThrow('PLEATKIT_MODEL')
    const c = configFromEnv({ PLEATKIT_PROVIDER: 'openrouter', PLEATKIT_API_KEY: 'x', PLEATKIT_MODEL: 'anthropic/claude-sonnet-5.5' })
    expect(c.provider.name).toBe('openai-compatible')
  })
})
