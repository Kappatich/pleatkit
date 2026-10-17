import { describe, expect, it } from 'vitest'
import type { AgentResult } from '@morphkit/runtime/compiler'
import { PROMPT_VERSION } from '../src/prompt.js'
import { createAgentApp, usageEvents } from '../src/server.js'
import { CARD, GOOD_CARD, request, scripted } from './helpers.js'

const turns = [
  { calls: [{ tool: 'write_file', input: { path: CARD, content: GOOD_CARD } }, { tool: 'check', input: {} }] },
  { calls: [{ tool: 'finish', input: { verdict: 'ok', summary: 'Added.' } }] },
]

/** A fake store-server: records calls, answers flags/quota/plan/requests/events. */
function fakeStore(flags: Record<string, unknown> = {}) {
  const calls: { path: string; body: unknown; headers: Headers }[] = []
  let ids = 0
  const fetchFn = (async (input: string, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ path: url.pathname, body, headers: new Headers(init?.headers) })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
    if (url.pathname === '/v1/flags') return json({ flags: { 'morphkit.enabled': true, 'edits.enabled': true, ...flags } })
    if (url.pathname === '/v1/quota') return json({ ok: true, tokens: {} })
    if (url.pathname === '/v1/plan') return json({ plan: null, limits: {} })
    if (url.pathname === '/v1/requests') return json({ id: `req_${++ids}` }, 201)
    if (url.pathname === '/v1/events') return json({ stored: (body as { events: unknown[] }).events.length }, 201)
    return json({ error: 'not found' }, 404)
  }) as unknown as typeof fetch
  return { calls, fetchFn }
}

async function result(res: Response): Promise<AgentResult> {
  const chunk = (await res.text()).split('\n\n').find((c) => c.startsWith('event: result'))!
  return JSON.parse(/^data: (.*)$/m.exec(chunk)![1]!) as AgentResult
}
const run = (app: ReturnType<typeof createAgentApp>, body: unknown, headers: Record<string, string> = {}) =>
  app.request('/agent/v1/run', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

describe('agent server foundations', () => {
  it('F6: the kill switch and edits.enabled refuse runs without calling the model', async () => {
    for (const flags of [{ 'morphkit.enabled': false }, { 'edits.enabled': false }]) {
      const provider = scripted({ name: 'phone', turns })
      const store = fakeStore(flags)
      const app = createAgentApp({ provider, storeUrl: 'http://store.test', fetch: store.fetchFn, log: () => undefined })
      const r = await result(await run(app, request('phone')))
      expect(r).toMatchObject({ verdict: 'refused', refusal: 'disabled', modelCalls: 0 })
      expect(r.summary).toMatch(/switched off/)
      expect(provider.received).toHaveLength(0)
    }
  })

  it('F3/F4: a run is logged with its prompt version and appends edit.requested, tokens.used and cost.usd', async () => {
    const store = fakeStore()
    const app = createAgentApp({ provider: scripted({ name: 'phone', turns }), storeUrl: 'http://store.test', fetch: store.fetchFn, log: () => undefined })
    const r = await result(await run(app, request('phone'), { 'idempotency-key': 'k-1' }))
    expect(r.promptVersion).toBe(PROMPT_VERSION)
    await new Promise((res) => setTimeout(res, 10)) // events are sent after the result
    const logged = store.calls.find((c) => c.path === '/v1/requests')!
    expect(logged.body).toMatchObject({ promptVersion: PROMPT_VERSION })
    expect(logged.headers.get('idempotency-key')).toBe('run:k-1')
    const sent = store.calls.find((c) => c.path === '/v1/events')!.body as { events: { type: string; dedupeKey: string }[] }
    const types = sent.events.map((e) => e.type)
    expect([types[0], types.at(-1)]).toEqual(['edit.requested', 'cost.usd'])
    expect(types.slice(1, -1).every((t) => t === 'tokens.used')).toBe(true) // one per model (classifier, main)
    expect(sent.events[0]!.dedupeKey).toBe('edit.requested:k-1')
  })

  it('F5: a retried run with the same Idempotency-Key gets the first result, the model runs once', async () => {
    const provider = scripted({ name: 'phone', turns })
    const app = createAgentApp({ provider, log: () => undefined })
    const [a, b] = await Promise.all([run(app, request('phone'), { 'idempotency-key': 'same' }), run(app, request('phone'), { 'idempotency-key': 'same' })])
    const [ra, rb] = await Promise.all([result(a), result(b)])
    expect(ra.files).toEqual(rb.files)
    expect(provider.received).toHaveLength(1)
    const again = await run(app, request('phone'), { 'idempotency-key': 'same' })
    expect((await result(again)).verdict).toBe('ok')
    expect(provider.received).toHaveLength(1)
    // another key runs again
    await result(await run(app, request('phone'), { 'idempotency-key': 'other' }))
    expect(provider.received).toHaveLength(2)
  })

  it('usage events carry no request text or code', () => {
    const r = { verdict: 'ok', summary: 'Added.', files: { [CARD]: GOOD_CARD }, deleted: [], log: [], classification: 'ui', provider: 'anthropic', model: 'claude-sonnet-5-5', usage: [{ model: 'claude-sonnet-5-5', calls: 2, costUsd: 0.03, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0 }], modelCalls: 2, timings: { totalMs: 1, classifyMs: null, modelMs: 1, toolsMs: 0 } } as Omit<AgentResult, 'requestId'>
    const ev = usageEvents(r, 'req_1', 'alice', 'k')
    expect(JSON.stringify(ev)).not.toContain('export default')
    expect(ev.find((e) => e.type === 'tokens.used')).toMatchObject({ value: 160, unit: 'token' })
    expect(ev.find((e) => e.type === 'cost.usd')).toMatchObject({ value: 0.03, unit: 'usd' })
  })
})
