import { describe, expect, it } from 'vitest'
import type { AgentResult, RequestClass } from '@pleatkit/runtime/compiler'
import { answeredByClassifierAlone, ClassifierModes, classifierRan, decideClassifierMode, type ClassifierBucket } from '../src/classifier-mode.js'
import { classifierSettingFromEnv, configFromEnv } from '../src/config.js'
import { runAgent } from '../src/loop.js'
import { createAgentApp } from '../src/server.js'
import type { Classification, ModelProvider, ModelTurn } from '../src/types.js'
import { CARD, GOOD_CARD, request } from './helpers.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }

/** A finished run as the server sees it: classified (or not), answered by the classifier alone (or not). */
const run = (alone: boolean, classified = true): Pick<AgentResult, 'timings' | 'verdict' | 'log' | 'modelCalls'> =>
  alone
    ? { verdict: 'needs-backend', log: [], modelCalls: 0, timings: { totalMs: 900, classifyMs: 900, modelMs: 0, toolsMs: 0 } }
    : { verdict: 'ok', log: [{ turn: 1, tool: 'finish', ok: true, ms: 1 } as never], modelCalls: 1, timings: { totalMs: 4000, classifyMs: classified ? 900 : null, modelMs: 3000, toolsMs: 40 } }

function clock(start = Date.UTC(2026, 9, 19, 12)) {
  let now = start
  return { now: () => now, advance: (ms: number) => void (now += ms) }
}

function feed(m: ClassifierModes, appId: string, alone: number, edits: number) {
  for (let i = 0; i < alone; i++) m.record(appId, run(true))
  for (let i = 0; i < edits; i++) m.record(appId, run(false))
}

/** A provider whose classifier gives `label` and whose main model writes the card and finishes. */
function provider(label: RequestClass): ModelProvider {
  return {
    name: 'fake',
    model: 'big-model',
    async classify(): Promise<Classification> {
      return { label, reason: 'Needs the server.', usage, model: 'small-model' }
    },
    start() {
      return {
        say: () => undefined,
        next: async (): Promise<ModelTurn> => ({
          text: '',
          toolCalls: [{ id: 'w', name: 'write_file', input: { path: CARD, content: GOOD_CARD } }, { id: 'f', name: 'finish', input: { verdict: 'ok', summary: 'Done.' } }],
          stop: 'tool_use',
          usage,
          model: 'big-model',
        }),
      }
    },
  }
}

describe('DECISIONS 75 Р5: the rule', () => {
  it('below the minimum sample stays parallel; above 50 % goes sequential; back at 45 % (hysteresis)', () => {
    expect(decideClassifierMode('parallel', 19, 19)).toBe('parallel')
    expect(decideClassifierMode('parallel', 20, 10)).toBe('parallel')
    expect(decideClassifierMode('parallel', 20, 11)).toBe('sequential')
    expect(decideClassifierMode('sequential', 100, 46)).toBe('sequential')
    expect(decideClassifierMode('sequential', 100, 45)).toBe('parallel')
    // fewer than the sample again (traffic stopped): the default
    expect(decideClassifierMode('sequential', 5, 5)).toBe('parallel')
  })

  it('the signal: classifier ran, no main-model call, no tool call, a classifier verdict', async () => {
    const backend = await runAgent(request('apply a discount on the server'), provider('needs-backend'))
    expect(backend.timings.classifierMode).toBe('parallel')
    expect(answeredByClassifierAlone(backend)).toBe(true)
    const edit = await runAgent(request('show the phone'), provider('ui'), { classifierMode: 'sequential' })
    expect(edit.timings.classifierMode).toBe('sequential')
    expect(classifierRan(edit)).toBe(true)
    expect(answeredByClassifierAlone(edit)).toBe(false)
    const pointed = await runAgent(request('show the phone', { target: 'customer-card' }), provider('ui'))
    expect(classifierRan(pointed)).toBe(false)
    expect(pointed.timings.classifierMode).toBeUndefined()
    // the main model's own needs-backend (through finish) is not the classifier's
    expect(answeredByClassifierAlone({ verdict: 'needs-backend', log: [{ turn: 1, tool: 'finish', ok: true, ms: 1 } as never], modelCalls: 1, timings: { totalMs: 1, classifyMs: 1, modelMs: 1, toolsMs: 0 } })).toBe(false)
  })
})

describe('ClassifierModes: per-app history', () => {
  it('switches above the threshold only after the minimum sample, logs every switch, and switches back', async () => {
    const c = clock()
    const lines: string[] = []
    const m = new ClassifierModes({ now: c.now, log: (l) => lines.push(l) })
    feed(m, 'crm', 15, 0)
    expect(await m.modeFor('crm')).toBe('parallel')
    feed(m, 'crm', 4, 0)
    expect(m.stats('crm')).toMatchObject({ mode: 'parallel', classified: 19, alone: 19 })
    feed(m, 'crm', 0, 1)
    // 19 of 20 answered alone
    expect(await m.modeFor('crm')).toBe('sequential')
    expect(lines).toEqual([expect.stringContaining('crm: classifier parallel -> sequential (19 of 20 classified requests in 7 days')])
    // 19 of 40: 47.5 %, inside the band, stays sequential
    feed(m, 'crm', 0, 20)
    expect(await m.modeFor('crm')).toBe('sequential')
    // 19 of 43: 44 %, back to parallel
    feed(m, 'crm', 0, 3)
    expect(await m.modeFor('crm')).toBe('parallel')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('sequential -> parallel')
    // runs the classifier did not run on are not counted
    m.record('crm', run(false, false))
    expect(m.stats('crm').classified).toBe(43)
  })

  it('exactly 50 % stays parallel', async () => {
    const m = new ClassifierModes({ now: clock().now })
    // edits and requests answered alone take turns, so the share never goes above 50 % on the way
    for (let i = 0; i < 15; i++) {
      feed(m, 'crm', 0, 1)
      feed(m, 'crm', 1, 0)
    }
    expect(m.stats('crm')).toMatchObject({ classified: 30, alone: 15, share: 0.5 })
    expect(await m.modeFor('crm')).toBe('parallel')
  })

  it('apps are independent', async () => {
    const m = new ClassifierModes({ now: clock().now })
    feed(m, 'support-portal', 25, 5)
    feed(m, 'crm', 5, 25)
    expect(await m.modeFor('support-portal')).toBe('sequential')
    expect(await m.modeFor('crm')).toBe('parallel')
    expect(await m.modeFor('new-app')).toBe('parallel')
    expect(Object.keys(m.snapshot()).sort()).toEqual(['crm', 'new-app', 'support-portal'])
  })

  it('the 7-day window: old requests expire and the mode returns to parallel', async () => {
    const c = clock()
    const m = new ClassifierModes({ now: c.now })
    feed(m, 'crm', 30, 0)
    expect(await m.modeFor('crm')).toBe('sequential')
    c.advance(3 * DAY)
    feed(m, 'crm', 0, 25)
    // 30 of 55 alone: still sequential
    expect(await m.modeFor('crm')).toBe('sequential')
    c.advance(4 * DAY + HOUR)
    // the first 30 left the window; 25 edits remain
    expect(m.stats('crm')).toMatchObject({ classified: 25, alone: 0 })
    expect(await m.modeFor('crm')).toBe('parallel')
    c.advance(7 * DAY + HOUR)
    expect(m.stats('crm')).toMatchObject({ classified: 0, share: null })
  })

  it('bounded memory: one bucket per hour, at most a week of them, and at most maxApps apps', () => {
    const c = clock()
    const m = new ClassifierModes({ now: c.now, maxApps: 2 })
    for (let h = 0; h < 24 * 30; h++) {
      feed(m, 'crm', 1, 1)
      c.advance(HOUR)
    }
    const buckets = (m as unknown as { apps: Map<string, { buckets: ClassifierBucket[] }> }).apps.get('crm')!.buckets
    expect(buckets.length).toBeLessThanOrEqual(7 * 24 + 1)
    m.record('a', run(true))
    m.record('b', run(true))
    expect(Object.keys(m.snapshot()).sort()).toEqual(['a', 'b'])
  })

  it('seeds an app from the store once, then counts on top of it', async () => {
    const c = clock()
    const asked: { appId: string; sinceMs: number }[] = []
    const m = new ClassifierModes({
      now: c.now,
      seed: async (appId, sinceMs) => {
        asked.push({ appId, sinceMs })
        if (appId !== 'support-portal') return []
        const hour = Math.floor(c.now() / HOUR) * HOUR
        return [
          { hourMs: hour - 2 * DAY, classified: 12, alone: 9 },
          { hourMs: hour - HOUR, classified: 10, alone: 6 },
        ]
      },
    })
    // two requests at once share one seed call
    const [a, b] = await Promise.all([m.modeFor('support-portal'), m.modeFor('support-portal')])
    expect([a, b]).toEqual(['sequential', 'sequential'])
    expect(m.stats('support-portal')).toMatchObject({ classified: 22, alone: 15, seeded: true })
    expect(await m.modeFor('crm')).toBe('parallel')
    expect(asked).toEqual([
      { appId: 'support-portal', sinceMs: c.now() - 7 * DAY },
      { appId: 'crm', sinceMs: c.now() - 7 * DAY },
    ])
    feed(m, 'support-portal', 0, 12)
    // 15 of 34: 44 %
    expect(await m.modeFor('support-portal')).toBe('parallel')
    expect(asked).toHaveLength(2)
  })

  it('a store that does not answer: memory only, logged once', async () => {
    const lines: string[] = []
    const m = new ClassifierModes({ now: clock().now, log: (l) => lines.push(l), seed: async () => Promise.reject(new Error('store-server GET /classifier-stats responded 404')) })
    expect(await m.modeFor('crm')).toBe('parallel')
    expect(await m.modeFor('crm')).toBe('parallel')
    expect(lines).toEqual([expect.stringContaining('crm: no classifier history from store-server')])
    expect(m.stats('crm').seeded).toBe(false)
  })
})

async function resultOf(res: Response): Promise<AgentResult> {
  const chunk = (await res.text()).split('\n\n').find((x) => x.startsWith('event: result'))!
  return JSON.parse(/^data: (.*)$/m.exec(chunk)![1]!) as AgentResult
}

/** store-server with a week of history for `support-portal` (30 classified, 24 answered alone). */
function fakeStore() {
  const calls: { path: string; body: unknown }[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path: url.pathname + url.search, body })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
    const app = new Headers(init?.headers).get('x-pleatkit-app')
    if (url.pathname === '/v1/classifier-stats') return json({ buckets: app === 'support-portal' ? [{ hourMs: Math.floor(Date.now() / HOUR) * HOUR - DAY, classified: 30, alone: 24 }] : [] })
    if (url.pathname === '/v1/flags') return json({ flags: {} })
    if (url.pathname === '/v1/quota') return json({ ok: true, tokens: {} })
    if (url.pathname === '/v1/plan') return json({ plan: null, limits: {} })
    if (url.pathname === '/v1/requests') return json({ id: 'req_1' }, 201)
    if (url.pathname === '/v1/events') return json({ stored: 1 }, 201)
    return json({ error: 'not found' }, 404)
  }) as unknown as typeof fetch
  return { calls, fetchFn }
}

const post = (app: ReturnType<typeof createAgentApp>, body: unknown) =>
  app.request('/agent/v1/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('the agent server in auto mode', () => {
  it('seeds from store-server, runs the app sequential, logs the mode with the request and shows it in health', async () => {
    const store = fakeStore()
    const lines: string[] = []
    const app = createAgentApp({ provider: provider('ui'), storeUrl: 'http://store.test', fetch: store.fetchFn, log: (l) => lines.push(l) })
    const r = await resultOf(await post(app, request('show the phone', { appId: 'support-portal' })))
    expect(r.verdict).toBe('ok')
    expect(r.timings.classifierMode).toBe('sequential')
    expect(lines).toContainEqual(expect.stringContaining('support-portal: classifier parallel -> sequential (24 of 30'))
    const logged = store.calls.find((c) => c.path === '/v1/requests')!.body as { timings: { classifierMode?: string } }
    expect(logged.timings.classifierMode).toBe('sequential')
    expect(store.calls.filter((c) => c.path.startsWith('/v1/classifier-stats?sinceMs='))).toHaveLength(1)
    // another app with no history: parallel
    const other = await resultOf(await post(app, request('show the phone', { appId: 'crm' })))
    expect(other.timings.classifierMode).toBe('parallel')
    const health = (await (await app.request('/agent/v1/health')).json()) as { classifier: { setting: string; apps: Record<string, { mode: string; classified: number }> } }
    expect(health.classifier.setting).toBe('auto')
    expect(health.classifier.apps['support-portal']).toMatchObject({ mode: 'sequential', classified: 31, seeded: true })
    expect(health.classifier.apps.crm).toMatchObject({ mode: 'parallel', classified: 1 })
  })

  it('an explicit PLEATKIT_CLASSIFIER overrides auto: no history is read', async () => {
    for (const mode of ['parallel', 'sequential'] as const) {
      const store = fakeStore()
      const app = createAgentApp({ provider: provider('ui'), storeUrl: 'http://store.test', fetch: store.fetchFn, classifierMode: mode, log: () => undefined })
      const r = await resultOf(await post(app, request('show the phone', { appId: 'support-portal' })))
      expect(r.timings.classifierMode).toBe(mode)
      expect(store.calls.some((c) => c.path.startsWith('/v1/classifier-stats'))).toBe(false)
      expect(await (await app.request('/agent/v1/health')).json()).toMatchObject({ classifier: { setting: mode } })
    }
  })

  it('a pointed-at panel does not wait for the history', async () => {
    const store = fakeStore()
    const app = createAgentApp({ provider: provider('ui'), storeUrl: 'http://store.test', fetch: store.fetchFn, log: () => undefined })
    const r = await resultOf(await post(app, request('show the phone', { appId: 'support-portal', target: 'customer-card' })))
    expect(r.verdict).toBe('ok')
    expect(r.timings.classifierMode).toBeUndefined()
    expect(store.calls.some((c) => c.path.startsWith('/v1/classifier-stats'))).toBe(false)
  })
})

describe('PLEATKIT_CLASSIFIER', () => {
  it('auto by default; parallel and sequential as given; anything else is an error', () => {
    expect(configFromEnv({}).classifierMode).toBe('auto')
    expect(configFromEnv({ PLEATKIT_CLASSIFIER: 'sequential' }).classifierMode).toBe('sequential')
    expect(classifierSettingFromEnv(' Parallel ')).toBe('parallel')
    expect(classifierSettingFromEnv('auto')).toBe('auto')
    expect(() => classifierSettingFromEnv('seqential')).toThrow(/auto, parallel or sequential/)
  })
})
