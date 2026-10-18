import { describe, expect, it } from 'vitest'
import type { AgentProgress } from '@pleatkit/runtime/compiler'
import { configFromEnv } from '../src/config.js'
import { runAgent } from '../src/loop.js'
import { callModel, classifyFailure, ModelGate, RateLimitedError, retryAfterMs } from '../src/rate-limit.js'
import { usageEvents } from '../src/server.js'
import type { Classification, ModelProvider, ModelTurn } from '../src/types.js'
import { CARD, GOOD_CARD, request } from './helpers.js'

/** What the Anthropic SDK throws on a 429: a status and the response headers. */
const limited = (retryAfter?: string, status = 429) => Object.assign(new Error(`${status} {"type":"error","error":{"type":"rate_limit_error"}}`), { status, headers: new Headers(retryAfter ? { 'retry-after': retryAfter } : {}) })
const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }

/** A provider whose main model answers 429 `failures` times, then writes the card and finishes. */
function busyProvider(failures: number, o: { retryAfter?: string; status?: number } = {}) {
  let calls = 0
  let refused = 0
  const provider: ModelProvider = {
    name: 'busy',
    model: 'big-model',
    async classify(): Promise<Classification> {
      return { label: 'ui', reason: '', usage: null, model: null }
    },
    start() {
      let turn = 0
      return {
        say: () => undefined,
        next: async (): Promise<ModelTurn> => {
          calls++
          if (refused < failures) {
            refused++
            throw limited(o.retryAfter, o.status)
          }
          turn++
          const toolCalls = turn === 1 ? [{ id: 'w', name: 'write_file', input: { path: CARD, content: GOOD_CARD } }, { id: 'f', name: 'finish', input: { verdict: 'ok', summary: 'Done.' } }] : []
          return { text: '', toolCalls, stop: 'tool_use', usage, model: 'big-model' }
        },
      }
    },
  }
  return { provider, calls: () => calls }
}

describe('stage 5 block 3: rate limits', () => {
  it('reads retry-after (seconds, ms, a date) and tells rate limits from other failures', () => {
    expect(retryAfterMs(new Headers({ 'retry-after': '3' }))).toBe(3000)
    expect(retryAfterMs(new Headers({ 'retry-after-ms': '250' }))).toBe(250)
    expect(retryAfterMs(new Headers({ 'retry-after': new Date(10_000).toUTCString() }), 4_000)).toBe(6000)
    expect(retryAfterMs(new Headers())).toBeNull()
    expect(classifyFailure(limited('2'))).toEqual({ kind: 'rate-limit', status: 429, retryAfterMs: 2000 })
    expect(classifyFailure(Object.assign(new Error('{"type":"overloaded_error"}'), { status: 529 })).kind).toBe('rate-limit')
    expect(classifyFailure(Object.assign(new Error('bad request'), { status: 400 })).kind).toBe('fatal')
    expect(classifyFailure(Object.assign(new Error('boom'), { status: 500 })).kind).toBe('transient')
    expect(classifyFailure(new Error('plain')).kind).toBe('fatal')
  })

  it('a 429 is retried after retry-after with a "busy, retrying" step, and the edit goes through', async () => {
    const { provider, calls } = busyProvider(2, { retryAfter: '0.05' })
    const steps: AgentProgress[] = []
    const r = await runAgent(request('show the phone'), provider, { classify: false, gate: new ModelGate(8), onProgress: (p) => steps.push(p) })
    expect(r.verdict).toBe('ok')
    expect(calls()).toBe(3)
    const busy = steps.filter((s) => s.type === 'status' && /busy, retrying/.test(s.text))
    expect(busy).toHaveLength(2)
    expect(r.rateLimited).toBeUndefined()
  })

  it('still limited after the retries: a failed verdict with rateLimited, a plain message, and a usage event for /admin', async () => {
    const { provider, calls } = busyProvider(10, { retryAfter: '0.01' })
    const r = await runAgent(request('show the phone'), provider, { classify: false, gate: new ModelGate(8), rateLimitRetries: 3 })
    expect(calls()).toBe(4)
    expect(r).toMatchObject({ verdict: 'failed', rateLimited: true, stopReason: 'rate-limited', files: {} })
    expect(r.summary).toMatch(/too busy right now/)
    const events = usageEvents(r, 'req_1', 'alice', 'k1')
    expect(events.find((e) => e.type === 'edit.rate_limited')).toMatchObject({ value: 1, unit: 'edit', dedupeKey: 'edit.rate_limited:k1' })
    expect(usageEvents({ ...r, rateLimited: undefined }, 'req_1', 'alice', 'k1').some((e) => e.type === 'edit.rate_limited')).toBe(false)
  })

  it('no retry the deadline would cancel: a long retry-after fails at once instead of waiting and paying for a cut-off call', async () => {
    const { provider, calls } = busyProvider(10, { retryAfter: '20' })
    const t0 = performance.now()
    const r = await runAgent(request('show the phone'), provider, { classify: false, gate: new ModelGate(8), limits: { timeoutMs: 5_000 } })
    expect(performance.now() - t0).toBeLessThan(1_000)
    expect(calls()).toBe(1)
    expect(r).toMatchObject({ verdict: 'failed', rateLimited: true })
    expect(r.error).toMatch(/would not finish before the run times out/)
  })

  it('overloaded (529) counts as a rate limit too; a fatal error is not retried', async () => {
    const over = busyProvider(1, { retryAfter: '0.01', status: 529 })
    expect((await runAgent(request('x'), over.provider, { classify: false, gate: new ModelGate(8) })).verdict).toBe('ok')
    let n = 0
    await expect(callModel(() => Promise.reject(Object.assign(new Error('bad'), { status: 400, n: ++n })), { signal: new AbortController().signal, deadline: performance.now() + 60_000, gate: new ModelGate(1) })).rejects.toThrow('bad')
    expect(n).toBe(1)
    await expect(callModel(() => Promise.reject(limited('0.01')), { signal: new AbortController().signal, deadline: performance.now() + 60_000, gate: new ModelGate(1), retries: 0 })).rejects.toBeInstanceOf(RateLimitedError)
  })

  it('the gate runs at most N calls at a time, first come first served, and frees a slot while a call waits to retry', async () => {
    const gate = new ModelGate(2)
    const order: string[] = []
    let running = 0
    let peak = 0
    const job = (id: string, ms: number) =>
      callModel(
        async () => {
          running++
          peak = Math.max(peak, running)
          order.push(id)
          await new Promise((r) => setTimeout(r, ms))
          running--
          return id
        },
        { signal: new AbortController().signal, deadline: performance.now() + 60_000, gate },
      )
    const out = await Promise.all([job('a', 40), job('b', 40), job('c', 10), job('d', 10), job('e', 10)])
    expect(out).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(peak).toBe(2)
    expect(order).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(gate.load).toEqual({ active: 0, queued: 0 })
    // a cancelled request leaves the queue
    const hold = await gate.acquire()
    const hold2 = await gate.acquire()
    const ac = new AbortController()
    const waiting = gate.acquire(ac.signal)
    expect(gate.load.queued).toBe(1)
    ac.abort(new Error('gone'))
    await expect(waiting).rejects.toThrow('gone')
    expect(gate.load.queued).toBe(0)
    hold()
    hold2()
  })

  it('PLEATKIT_MODEL_CONCURRENCY and PLEATKIT_RATE_LIMIT_RETRIES, with defaults 8 and 3', () => {
    expect(configFromEnv({})).toMatchObject({ modelConcurrency: 8, rateLimitRetries: 3 })
    expect(configFromEnv({ PLEATKIT_MODEL_CONCURRENCY: '3', PLEATKIT_RATE_LIMIT_RETRIES: '1' })).toMatchObject({ modelConcurrency: 3, rateLimitRetries: 1 })
  })
})
