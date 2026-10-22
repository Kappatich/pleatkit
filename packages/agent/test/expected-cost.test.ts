import { describe, expect, it } from 'vitest'
import type { PleatkitManifest } from '@pleatkit/runtime/compiler'
import { mintUserToken } from '@pleatkit/runtime/security'
import { AnthropicProvider, createAgentApp, ScriptedProvider } from '../src/index.js'
import { appExpectedCost, EDIT_COST_ASSUMPTIONS, expectedEditCost, formatUsd } from '../src/expected-cost.js'
import { CHARS_PER_TOKEN, estimatePromptTokens, type PromptTokenCount } from '../src/prefix.js'

const SONNET = 'claude-sonnet-5-5'
const HAIKU = 'claude-haiku-5-5'

const manifest: PleatkitManifest = {
  version: 1,
  dynamicRoots: ['src/dynamic/'],
  dynamic: [{ path: 'src/dynamic/card.tsx', source: 'export default function Card() { return <div>Card</div> }\n' }],
  readonly: [{ path: 'src/readonly/api.ts', source: 'export interface Customer { id: string }\n' }],
  coreTypes: [],
  externals: ['react', 'react/jsx-runtime', '@/readonly/api'],
  externalPatterns: ['react', 'react/jsx-runtime', '@/readonly/*'],
  alias: { '@': 'src' },
}

describe('DECISIONS 75 Р2: the expected cost of an edit', () => {
  it('a warm edit: prefix read, tail written, typical output, a weighted second call and the classifier', () => {
    // shadcn-admin as the 5f live runs saw it: 13 018 tokens read from the cache, 10 343 written
    const e = expectedEditCost({ prefixTokens: 13_018, tailTokens: 10_343 }, SONNET, HAIKU)
    const b = e.breakdown!
    expect(b.prefixReadUsd).toBeCloseTo(13_018 * 0.2e-6, 10)
    expect(b.tailUsd).toBeCloseTo(10_343 * 2e-6, 10)
    expect(b.outputUsd).toBeCloseTo(4 * 2e-6 + 550 * 10e-6, 10)
    expect(b.secondCallUsd).toBeCloseTo(0.25 * (4 * 2e-6 + 23_361 * 0.2e-6 + 700 * 2.5e-6 + 200 * 10e-6), 10)
    expect(b.classifierUsd).toBeCloseTo(40 * 0.1e-6 + 2_000 * 0.01e-6 + 90 * 0.5e-6, 10)
    expect(e.expectedUsd).toBeCloseTo(b.prefixReadUsd + b.tailUsd + b.outputUsd + b.secondCallUsd + b.classifierUsd, 12)
    // the measured median of one-call shadcn-admin edits with cacheTail 'after-first' (DECISIONS 76.1) was
    // about $0.030: within 25 %
    expect(Math.abs(e.expectedUsd! / 0.0300 - 1)).toBeLessThan(0.25)
    expect(e).toMatchObject({ model: SONNET, classifierModel: HAIKU, prefixTokens: 13_018, tailTokens: 10_343, unpriced: [], assumptions: EDIT_COST_ASSUMPTIONS })
    expect(EDIT_COST_ASSUMPTIONS.prefixTtl).toBe('1h')
  })

  it('cold with the 1-hour TTL (the default since block 6): the prefix is written at 2x input', () => {
    const e = expectedEditCost({ prefixTokens: 13_018, tailTokens: 10_343 }, SONNET, HAIKU)
    const prefixDelta = 13_018 * (4e-6 - 0.2e-6)
    const classifierDelta = 2_000 * (0.125e-6 - 0.01e-6)
    expect(e.coldUsd! - e.expectedUsd!).toBeCloseTo(prefixDelta + classifierDelta, 10)
  })

  it('cold: after 5 minutes idle the prefix (and the classifier fixed part) is written instead of read', () => {
    const e = expectedEditCost({ prefixTokens: 13_018, tailTokens: 10_343 }, SONNET, HAIKU, { prefixTtl: '5m' })
    const prefixDelta = 13_018 * (2.5e-6 - 0.2e-6)
    const classifierDelta = 2_000 * (0.125e-6 - 0.01e-6)
    expect(e.coldUsd! - e.expectedUsd!).toBeCloseTo(prefixDelta + classifierDelta, 10)
    // the probe-5f cold run on shadcn-admin cost $0.0626 (23 363 tokens written, 381 output)
    expect(Math.abs(e.coldUsd! / 0.0626 - 1)).toBeLessThan(0.25)
  })

  it('no classifier, an uncached tail, overridden constants', () => {
    const e = expectedEditCost({ prefixTokens: 1_000, tailTokens: 1_000 }, SONNET, null, { tailWrite: false, twoCallShare: 0, outputTokens: 100 })
    expect(e.classifierModel).toBeNull()
    expect(e.breakdown).toMatchObject({ classifierUsd: 0, secondCallUsd: 0 })
    expect(e.breakdown!.tailUsd).toBeCloseTo(1_000 * 2e-6, 10)
    expect(e.expectedUsd).toBeCloseTo(1_000 * 0.2e-6 + 1_000 * 2e-6 + 4 * 2e-6 + 100 * 10e-6, 10)
  })

  it('a model without a price: no totals, and the report names it', () => {
    const e = expectedEditCost({ prefixTokens: 1_000, tailTokens: 500 }, 'gpt-x', HAIKU)
    expect(e).toMatchObject({ expectedUsd: null, coldUsd: null, breakdown: null, unpriced: ['gpt-x'] })
    expect(formatUsd(0.03614)).toBe('$0.0361')
    expect(formatUsd(1.5)).toBe('$1.50')
  })

  it('the estimate splits the prompt the agent would build into prefix and tail by characters', () => {
    const est = estimatePromptTokens(manifest)
    expect(CHARS_PER_TOKEN).toBe(2.5)
    expect(est.model).toBe(SONNET)
    expect(est.prefixTokens).toBeGreaterThan(2_000) // the instructions and the tools alone
    expect(est.tailTokens).toBeGreaterThan(10)
    expect(est.tailTokens).toBeLessThan(est.prefixTokens)
  })
})

describe('DECISIONS 75 Р2: the agent server computes it for /admin', () => {
  it('counted with the provider when it can count, cached per release and model; estimated when the counter fails', async () => {
    let calls = 0
    const provider = {
      name: 'anthropic',
      model: SONNET,
      classifierModel: HAIKU,
      countPromptTokens: async (): Promise<PromptTokenCount> => (calls++, { prefixTokens: 8_000, tailTokens: 2_000, model: SONNET, promptVersion: 'p' }),
    }
    const cache = new Map<string, PromptTokenCount>()
    const a = await appExpectedCost(manifest, provider, cache)
    const b = await appExpectedCost(manifest, provider, cache)
    expect(calls).toBe(1)
    expect(a).toMatchObject({ source: 'counted', prefixTokens: 8_000, tailTokens: 2_000, promptVersion: 'p' })
    expect(b.expectedUsd).toBe(a.expectedUsd)
    const failing = { ...provider, countPromptTokens: async () => Promise.reject(new Error('overloaded')) }
    const c = await appExpectedCost(manifest, failing, new Map())
    expect(c.source).toBe('estimated')
    expect(c.note).toMatch(/token counter failed \(overloaded\)/)
  })

  it('the scripted demo provider is priced as the default models', async () => {
    const e = await appExpectedCost(manifest, new ScriptedProvider([]), new Map())
    expect(e).toMatchObject({ source: 'estimated', model: SONNET, classifierModel: HAIKU })
    expect(e.expectedUsd).toBeGreaterThan(0)
    expect(e.note).toMatch(/priced as claude-sonnet-5-5/)
  })

  it('POST /agent/v1/expected-cost counts with count_tokens once (Anthropic with a key), for admins only', async () => {
    const counted: string[] = []
    const fetch = (async (url: string, init?: RequestInit) => {
      expect(String(url)).toMatch(/\/v1\/messages\/count_tokens/)
      const body = JSON.parse(String(init?.body)) as { system?: unknown; model: string }
      counted.push(body.model)
      return new Response(JSON.stringify({ input_tokens: body.system ? 13_400 : 400 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof globalThis.fetch
    const provider = new AnthropicProvider({ apiKey: 'k', baseURL: 'http://anthropic.test', fetch })
    const app = createAgentApp({ provider, manifest, log: () => undefined, quotas: false, alerts: false })
    const post = (headers: Record<string, string>) => app.request('/agent/v1/expected-cost', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ appId: 'crm' }) })
    expect((await post({})).status).toBe(403)
    const res = await post({ 'x-pleatkit-admin': '1' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { source: string; prefixTokens: number; tailTokens: number; expectedUsd: number; coldUsd: number; model: string; classifierModel: string }
    expect(body).toMatchObject({ source: 'counted', prefixTokens: 13_000, tailTokens: 400, model: SONNET, classifierModel: HAIKU })
    expect(body.expectedUsd).toBeCloseTo(expectedEditCost({ prefixTokens: 13_000, tailTokens: 400 }, SONNET, HAIKU).expectedUsd!, 12)
    expect(body.coldUsd).toBeGreaterThan(body.expectedUsd)
    expect(counted).toEqual([SONNET, SONNET])
    expect((await post({ 'x-pleatkit-admin': '1' })).status).toBe(200)
    expect(counted).toHaveLength(2) // the second request came from the cache

    // with credentials: an admin token, nothing else
    const SECRET = 'j'.repeat(40)
    const secure = createAgentApp({ provider, manifest, log: () => undefined, quotas: false, alerts: false, auth: { credentials: { appId: 'crm', appKey: 'mk_live_0123456789abcdefghijklmnop', jwtSecret: SECRET }, production: false } })
    const as = async (role: 'user' | 'admin') => secure.request('/agent/v1/expected-cost', { method: 'POST', headers: { authorization: `Bearer ${await mintUserToken({ secret: SECRET, userId: 'x', appId: 'crm', role })}` }, body: '{}' })
    expect((await as('user')).status).toBe(403)
    expect((await as('admin')).status).toBe(200)

    const noManifest = createAgentApp({ provider, log: () => undefined, quotas: false, alerts: false })
    expect((await noManifest.request('/agent/v1/expected-cost', { method: 'POST', headers: { 'x-pleatkit-admin': '1' }, body: '{}' })).status).toBe(400)
  })
})
