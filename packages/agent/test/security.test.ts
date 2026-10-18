import { describe, expect, it } from 'vitest'
import { mintUserToken, type AgentResult } from '@pleatkit/runtime/compiler'
import { agentAuthFromEnv, identify } from '../src/auth.js'
import { configFromEnv } from '../src/config.js'
import { runAgent } from '../src/loop.js'
import { MemoryQuotaBackend, Quotas, resolvePlan } from '../src/quota.js'
import { createAgentApp } from '../src/server.js'
import type { ModelProvider } from '../src/types.js'
import { CARD, GOOD_CARD, request, scripted } from './helpers.js'

const SECRET = 'j'.repeat(40)
const APP_KEY = 'mk_live_0123456789abcdefghijklmnop'
const auth = { credentials: { appId: 'test', appKey: APP_KEY, jwtSecret: SECRET }, production: false }

const lastEvent = async (res: Response) => {
  const chunks = (await res.text()).split('\n\n').filter((c) => c.includes('event: result') || c.includes('event: error'))
  return JSON.parse(/^data: (.*)$/m.exec(chunks.at(-1)!)![1]!) as AgentResult
}
const post = (app: ReturnType<typeof createAgentApp>, body: unknown, headers: Record<string, string> = {}) =>
  app.request('/agent/v1/run', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

const phone = scripted({
  name: 'phone',
  turns: [
    { calls: [{ tool: 'write_file', input: { path: CARD, content: GOOD_CARD } }, { tool: 'check', input: {} }] },
    { calls: [{ tool: 'finish', input: { verdict: 'ok', summary: 'Added.' } }] },
  ],
})

describe('agent credentials (V1 A1)', () => {
  it('refuses to start in production without credentials, validates them', () => {
    expect(() => agentAuthFromEnv({ NODE_ENV: 'production' })).toThrow(/refusing to start/)
    expect(() => configFromEnv({ NODE_ENV: 'production' })).toThrow(/refusing to start/)
    expect(() => agentAuthFromEnv({ PLEATKIT_APP_KEY: 'nope', PLEATKIT_JWT_SECRET: SECRET })).toThrow(/mk_live_/)
    expect(agentAuthFromEnv({ NODE_ENV: 'production', PLEATKIT_APP_ID: 'crm', PLEATKIT_APP_KEY: APP_KEY, PLEATKIT_JWT_SECRET: SECRET }).credentials?.appId).toBe('crm')
    expect(agentAuthFromEnv({}).credentials).toBeNull()
  })

  it('the user token decides the user; the body cannot claim another one', async () => {
    const token = await mintUserToken({ secret: SECRET, userId: 'alice', appId: 'test' })
    expect(await identify(`Bearer ${token}`, { userId: 'alice' }, auth)).toMatchObject({ userId: 'alice', appId: 'test', via: 'jwt' })
    await expect(identify(`Bearer ${token}`, { userId: 'bob' }, auth)).rejects.toMatchObject({ status: 403 })
    await expect(identify(undefined, { userId: 'alice', appId: 'test' }, auth)).rejects.toMatchObject({ status: 401 })
    await expect(identify(undefined, { userId: 'alice', appId: 'other' }, { ...auth, production: true })).rejects.toMatchObject({ status: 401 })
    // development: an app without credentials is trusted as sent
    expect(await identify(undefined, { userId: 'alice', appId: 'other' }, auth)).toMatchObject({ userId: 'alice', via: 'demo' })
  })

  it('/run needs the token for the app with credentials', async () => {
    const app = createAgentApp({ provider: phone, auth, log: () => undefined })
    expect((await post(app, request('phone'))).status).toBe(401)
    const token = await mintUserToken({ secret: SECRET, userId: 'alice', appId: 'test' })
    const result = await lastEvent(await post(app, request('phone'), { authorization: `Bearer ${token}` }))
    expect(result.verdict).toBe('ok')
  })
})

describe('quotas (V1 A4)', () => {
  it('a user over the daily edit limit gets one fixed reply and no model call', async () => {
    const provider = scripted({ name: 'phone', turns: phone.find('phone')!.turns })
    const quotas = new Quotas(new MemoryQuotaBackend(), async () => resolvePlan('free', { userDailyEdits: 1 }))
    const app = createAgentApp({ provider, quotas, log: () => undefined })
    expect((await lastEvent(await post(app, request('phone')))).verdict).toBe('ok')
    const refused = await lastEvent(await post(app, { ...request('phone'), locale: 'ru' }))
    expect(refused).toMatchObject({ verdict: 'refused', refusal: 'quota', modelCalls: 0 })
    expect(refused.summary).toMatch(/лимит/)
    expect(provider.received).toHaveLength(1)
    // another user of the same app still has edits left
    expect((await lastEvent(await post(app, { ...request('phone'), userId: 'bob' }))).verdict).toBe('ok')
  })

  it('the app-wide dollar bucket blocks everyone once the cost is debited', async () => {
    const quotas = new Quotas(new MemoryQuotaBackend(), async () => resolvePlan('free', { appDailyUsd: 0.01 }))
    const who = { appId: 'a', orgId: 'default', userId: 'alice', environment: null, via: 'demo' as const }
    expect((await quotas.beforeEdit(who)).ok).toBe(true)
    await quotas.afterEdit(who, 0.05)
    expect(await quotas.beforeEdit({ ...who, userId: 'bob' })).toMatchObject({ ok: false, limit: 'app-usd' })
  })

  it('the per-edit dollar limit stops the loop', async () => {
    // a priced model that reports a large usage on every turn
    let turns = 0
    const pricey: ModelProvider = {
      name: 'fake',
      model: 'claude-sonnet-5-5',
      classify: async () => ({ label: 'ui', reason: '', usage: null, model: null }),
      start: () => ({
        say: () => undefined,
        next: async () => {
          turns++
          return {
            text: '',
            toolCalls: [{ id: `c${turns}`, name: 'read_file', input: { path: CARD } }],
            stop: 'tool_use',
            usage: { inputTokens: 100_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
            model: 'claude-sonnet-5-5',
          }
        },
      }),
    }
    const result = await runAgent(request('x', { target: 'customer-card' }), pricey, { limits: { maxCostUsd: 0.3 } })
    expect(result).toMatchObject({ verdict: 'failed', stopReason: 'cost' })
    expect(turns).toBe(2) // $0.20 after one call, $0.40 after two: stopped before the third
  })

  it('an off-topic request gets one cheap reply; the big model is never started', async () => {
    const provider = scripted({ name: 'poem', classify: { label: 'off-topic', reason: '' }, turns: [] })
    const result = await runAgent(request('write me a poem'), provider)
    expect(result).toMatchObject({ verdict: 'refused', refusal: 'off-topic', modelCalls: 0, classification: 'off-topic' })
    expect(result.summary).toMatch(/only change how this app looks/)
    expect(provider.received).toHaveLength(0)
  })
})
