/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect raw JSON wire payloads */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createStoreApp, mintUserToken, openStore } from '../../store-server/src/index.js'
import { fileHashes, manifestReleaseHash, type PleatkitManifest, type Snapshot } from '@pleatkit/runtime/compiler'
import { EmailSink, WebhookSink } from '../src/alerts.js'
import { carryOverRelease, CARRIED_MESSAGE, MIGRATE_REQUEST, resolveRelease, rollbackRelease } from '../src/carry-over.js'
import { buildDigest, digestMarkdown, sendDigest } from '../src/digest.js'
import { costUsd } from '../src/pricing.js'
import { AnthropicProvider } from '../src/providers/anthropic.js'
import { RecordingProvider, ReplayProvider } from '../src/providers/recording.js'
import { ScriptedProvider, type ScriptFixture } from '../src/providers/scripted.js'
import { createAgentApp } from '../src/server.js'
import type { ModelProvider } from '../src/index.js'
import type { TokenUsage } from '@pleatkit/runtime/compiler'
import { buildWishMap, clusterWishes, DEFAULT_WISH_LIMITS, estimateClusterUsd, normalizeClusters, wishLimitsFromEnv, type ClusterInput, type WishItem } from '../src/wishes.js'
import { BASE_CARD, CARD, GOOD_CARD, TABLE } from './helpers.js'

function storeSetup(options: Parameters<typeof createStoreApp>[1] = {}) {
  const { db } = openStore()
  const store = createStoreApp(db, options)
  const fetchVia = ((input: string | URL | Request, init?: RequestInit) => store.request(input instanceof Request ? input : String(input), init)) as typeof fetch
  const call = async (method: string, p: string, headers: Record<string, string>, body?: unknown) =>
    store.request(`http://store.test/v1${p}`, { method, headers: { 'content-type': 'application/json', 'x-pleatkit-app': 'crm', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const request = async (userId: string, text: string, verdict: string, extra: Record<string, unknown> = {}) =>
    ((await (await call('POST', '/requests', { 'x-pleatkit-agent': '1', 'x-pleatkit-user': userId }, { userId, text, verdict, status: verdict === 'needs-backend' ? 'pending-admin' : 'refused', log: [], ...extra })).json()) as { id: string }).id
  const put = async (s: Snapshot, head: boolean) => {
    const h = { 'x-pleatkit-user': s.userId }
    expect((await call('PUT', `/snapshots/${s.id}`, h, s)).status).toBe(204)
    if (head) expect((await call('POST', `/snapshots/${s.id}/head`, h, {})).status).toBe(204)
  }
  const admin = { 'x-pleatkit-admin': '1' }
  return { store, db, fetchVia, call, request, put, admin }
}

const WISH_FIXTURE: ScriptFixture = {
  name: 'wishes',
  match: [],
  turns: [],
  wishes: [
    { panel: 'deals-table', title: 'Discounts that change the deal amount', kind: 'needs-backend', match: ['discount', 'скидк'] },
    { panel: 'header', title: 'Rename the app', kind: 'out-of-zone', match: ['title|header'] },
  ],
}
const scriptedWishes = () => new ScriptedProvider([{ ...WISH_FIXTURE, dir: '.', patterns: [] }])

describe('C9: the wish-list map, one classifier call', () => {
  const items: WishItem[] = [
    { id: 'r1', panel: null, kind: 'needs-backend', text: 'Add a discount field to deals' },
    { id: 'r2', panel: 'deals-table', kind: 'needs-backend', text: 'discount per customer, server side' },
    { id: 'r3', panel: null, kind: 'out-of-zone', text: 'change the title in the header' },
    { id: 'r4', panel: 'customer-card', kind: 'needs-backend', text: 'send an invoice by e-mail' },
  ]

  it('scripted: themes from the fixture, the rest in fallback themes, every request once', async () => {
    const map = await clusterWishes(scriptedWishes(), items, ['customer-card', 'deals-table'])
    expect(map.calls).toBe(1)
    expect(map.clusters).toEqual([
      { panel: 'deals-table', title: 'Discounts that change the deal amount', kind: 'needs-backend', requestIds: ['r1', 'r2'] },
      { panel: 'header', title: 'Rename the app', kind: 'out-of-zone', requestIds: ['r3'] },
      { panel: 'customer-card', title: 'send an invoice by e-mail', kind: 'needs-backend', requestIds: ['r4'] },
    ])
    expect(await clusterWishes(scriptedWishes(), [], [])).toMatchObject({ clusters: [], calls: 0 })
  })

  it('a model may not invent ids or put one request in two themes', () => {
    const out = normalizeClusters(
      [
        { panel: 'deals-table', title: 'Discounts', kind: 'needs-backend', requestIds: ['r1', 'nope', 'r2'] },
        { panel: 'deals-table', title: 'Again', kind: 'needs-backend', requestIds: ['r2'] },
        { panel: '', title: '', kind: 'needs-backend', requestIds: ['r3'] },
      ],
      items,
    )
    expect(out.map((k) => k.requestIds)).toEqual([['r1', 'r2'], ['r3'], ['r4']])
    // the kind follows the requests, a blank panel or title is filled in
    expect(out[1]).toMatchObject({ panel: 'other', kind: 'out-of-zone', title: 'change the title in the header' })
  })

  it('Anthropic: the classifier model with structured output; the answer is normalized', async () => {
    const calls: any[] = []
    const fetch = (async (_u: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)))
      const answer = { clusters: [{ panel: 'deals-table', title: 'Discounts', kind: 'needs-backend', request_ids: ['r1', 'r2'] }] }
      return new Response(
        JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: JSON.stringify(answer) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 300, output_tokens: 40 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof globalThis.fetch
    const map = await clusterWishes(new AnthropicProvider({ apiKey: 'test', baseURL: 'http://anthropic.test', fetch }), items, ['deals-table'])
    expect(calls).toHaveLength(1)
    expect(calls[0].model).toBe('claude-haiku-5-5')
    expect(calls[0].output_config.format.type).toBe('json_schema')
    expect(calls[0].messages[0].content).toContain('r3 | - | out-of-zone | change the title in the header')
    expect(map.model).toBe('claude-haiku-5-5')
    expect(map.clusters[0]).toMatchObject({ title: 'Discounts', requestIds: ['r1', 'r2'] })
    expect(map.clusters.flatMap((k) => k.requestIds).sort()).toEqual(['r1', 'r2', 'r3', 'r4'])
  })

  it('records the clustering call and replays it offline', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-wishes-'))
    const rec = new RecordingProvider(scriptedWishes(), { dir })
    const live = await clusterWishes(rec, items, [])
    const replayed = await clusterWishes(new ReplayProvider(rec.files[0]!), items, [])
    expect(replayed.clusters).toEqual(live.clusters)
  })

  it('buildWishMap reads the week from store-server and stores the map for /admin', async () => {
    const t = storeSetup()
    const a = await t.request('alice', 'Add a discount field to deals and recalculate the amount on the server', 'needs-backend')
    const b = await t.request('bob', 'Скидку в сделку, пересчёт на сервере', 'needs-backend')
    await t.request('bob', 'write me a poem', 'refused')
    const map = await buildWishMap({ provider: scriptedWishes(), storeUrl: 'http://store.test', appId: 'crm', fetch: t.fetchVia })
    expect(map).toMatchObject({ items: 2, calls: 1 })
    const stored = (await (await t.call('GET', '/admin/wishes', t.admin)).json()) as { map: { clusters: { title: string; requestIds: string[]; users: number }[] } }
    expect(stored.map.clusters).toEqual([expect.objectContaining({ title: 'Discounts that change the deal amount', requestIds: expect.arrayContaining([a, b]), users: 2 })])
  })

  it('agent server: POST /agent/v1/wishes is for admins only', async () => {
    const t = storeSetup()
    await t.request('alice', 'discount on deals', 'needs-backend')
    const app = createAgentApp({ provider: scriptedWishes(), log: () => undefined, storeUrl: 'http://store.test', fetch: t.fetchVia, quotas: false, alerts: false })
    const post = (headers: Record<string, string>) => app.request('/agent/v1/wishes', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ appId: 'crm' }) })
    expect((await post({})).status).toBe(403)
    const ok = await post({ 'x-pleatkit-admin': '1' })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { clusters: unknown[] }).clusters).toHaveLength(1)

    // with credentials: an admin token, nothing else
    const SECRET = 'j'.repeat(40)
    const creds = { appId: 'crm', appKey: 'mk_live_0123456789abcdefghijklmnop', jwtSecret: SECRET }
    const secure = createAgentApp({ provider: scriptedWishes(), log: () => undefined, storeUrl: 'http://store.test', fetch: t.fetchVia, quotas: false, alerts: false, auth: { credentials: creds, production: false } })
    const as = async (role: 'user' | 'admin') => secure.request('/agent/v1/wishes', { method: 'POST', headers: { authorization: `Bearer ${await mintUserToken({ secret: SECRET, userId: 'x', appId: 'crm', role })}` }, body: '{}' })
    expect((await as('user')).status).toBe(403)
    expect((await secure.request('/agent/v1/wishes', { method: 'POST', headers: { 'x-pleatkit-admin': '1' }, body: JSON.stringify({ appId: 'crm' }) })).status).toBe(401)
  })
})

describe('DECISIONS 70.3: the wish map reads at most 500 requests and spends at most $0.50 per call', () => {
  /** A clustering provider priced as Sonnet 5.5 that records what it was sent. */
  function counting(model = 'claude-sonnet-5-5') {
    const sent: ClusterInput[] = []
    const provider: ModelProvider = {
      name: 'counting',
      model,
      clusterModel: model,
      classify: async () => ({ label: 'ui', reason: '', usage: null, model: null }),
      start: () => {
        throw new Error('not used')
      },
      cluster: async (input) => (sent.push(input), { clusters: [{ panel: 'deals-table', title: 'All', kind: 'needs-backend', requestIds: input.items.map((i) => i.id) }], usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, model }),
    }
    return { provider, sent }
  }
  const many = (n: number): WishItem[] => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, panel: 'deals-table', kind: 'needs-backend', text: `request number ${i} `.padEnd(300, 'x') }))

  it('defaults 500 and $0.50; PLEATKIT_WISHES_* override them, bad values keep the defaults', () => {
    expect(DEFAULT_WISH_LIMITS).toEqual({ maxItems: 500, budgetUsd: 0.5 })
    expect(wishLimitsFromEnv({})).toEqual({ maxItems: 500, budgetUsd: 0.5 })
    expect(wishLimitsFromEnv({ PLEATKIT_WISHES_MAX_ITEMS: '50', PLEATKIT_WISHES_BUDGET_USD: '0.1' })).toEqual({ maxItems: 50, budgetUsd: 0.1 })
    expect(wishLimitsFromEnv({ PLEATKIT_WISHES_MAX_ITEMS: 'lots', PLEATKIT_WISHES_BUDGET_USD: '-1' })).toEqual({ maxItems: 500, budgetUsd: 0.5 })
  })

  it('one call reads the newest 500 of 600 requests by default', async () => {
    const c = counting()
    const map = await clusterWishes(c.provider, many(600), [])
    expect(c.sent[0]!.items).toHaveLength(500)
    expect(c.sent[0]!.items[0]!.id).toBe('r0')
    expect(map).toMatchObject({ items: 500, clustered: 500, calls: 1 })
    expect(map.estimatedUsd!).toBeLessThanOrEqual(0.5)
    expect(map.costUsd).toBeCloseTo(costUsd('claude-sonnet-5-5', { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 })!, 9)
  })

  it('over the budget the oldest requests are grouped without the model; nothing fits: no call at all', async () => {
    const c = counting()
    const map = await clusterWishes(c.provider, many(400), [], undefined, { budgetUsd: 0.06 })
    const n = c.sent[0]!.items.length
    expect(n).toBeGreaterThan(10)
    expect(n).toBeLessThan(400)
    expect(c.sent[0]!.items.map((i) => i.id)).toEqual(many(n).map((i) => i.id)) // the newest first
    expect(map.estimatedUsd!).toBeLessThanOrEqual(0.06)
    expect(estimateClusterUsd('claude-sonnet-5-5', { items: many(n + 1), panels: [] })!).toBeGreaterThan(0.06)
    expect(map).toMatchObject({ items: 400, clustered: n, calls: 1 })
    // every request is still in exactly one theme
    expect(map.clusters.flatMap((k) => k.requestIds).sort()).toEqual(many(400).map((i) => i.id).sort())

    const none = counting()
    const skipped = await clusterWishes(none.provider, many(5), [], undefined, { budgetUsd: 0.01 })
    expect(none.sent).toHaveLength(0)
    expect(skipped).toMatchObject({ calls: 0, clustered: 0, items: 5 })
    expect(skipped.clusters.flatMap((k) => k.requestIds)).toHaveLength(5)
  })

  it('store-server returns at most `limit` wish items (500 by default) and the total; buildWishMap asks for maxItems', async () => {
    const t = storeSetup()
    for (let i = 0; i < 7; i++) await t.request(`u${i}`, `wish ${i}`, 'needs-backend')
    await t.request('x', 'served', 'ok')
    const page = (await (await t.call('GET', '/admin/wish-items?limit=3', t.admin)).json()) as { total: number; items: { text: string }[] }
    expect(page.total).toBe(7)
    expect(page.items.map((i) => i.text)).toEqual(['wish 6', 'wish 5', 'wish 4'])
    const c = counting()
    const map = await buildWishMap({ provider: c.provider, storeUrl: 'http://store.test', appId: 'crm', fetch: t.fetchVia, limits: { maxItems: 4 } })
    expect(map).toMatchObject({ items: 4, total: 7, clustered: 4 })
    expect(c.sent[0]!.items).toHaveLength(4)
  })
})

describe('C5: the weekly digest', () => {
  it('markdown with the week in numbers, what waits on the admin, the audit chain and the wish map; sent as a digest alert', async () => {
    const t = storeSetup()
    await t.request('alice', 'Add a discount field to deals', 'needs-backend', { usage: [{ model: 'claude-sonnet-5-5', calls: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.05 }] })
    await t.request('bob', 'change the title in the header', 'not-editable')
    const d = await buildDigest({ storeUrl: 'http://store.test', appId: 'crm', provider: scriptedWishes(), fetch: t.fetchVia })
    expect(d.wishes).toMatchObject({ built: 'now', calls: 1 })
    expect(d.pending).toEqual({ review: 0, admin: 1 })
    expect(d.audit.ok).toBe(true)
    const md = digestMarkdown(d)
    expect(md).toContain('# pleatkit weekly digest: crm')
    expect(md).toContain('| Requests | 2 from 2 users in 1 organizations |')
    expect(md).toContain('needs backend 1, out of zone 1')
    expect(md).toContain('| Model cost | $0.0500 |')
    expect(md).toContain('| Waiting on you | 0 edits to review, 1 backend requests |')
    expect(md).toContain('### deals-table')
    expect(md).toContain('- **Discounts that change the deal amount** (needs backend): 1 request, 1 user')
    expect(md).toContain('| Audit chain | intact')

    // without a provider: the latest stored map
    expect((await buildDigest({ storeUrl: 'http://store.test', appId: 'crm', fetch: t.fetchVia })).wishes.built).toBe('stored')

    const posts: { url: string; body: any }[] = []
    const fake = (async (url: string, init?: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init?.body)) })
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    expect(await sendDigest(d, md, [new WebhookSink('http://hook.test', fake), new EmailSink('http://mail.test', 'ops@example.com', 'tok', fake)])).toBe(2)
    expect(posts[0]!.body.text).toContain('### deals-table')
    expect(posts[0]!.body.alert.kind).toBe('digest')
    expect(posts[1]!.body).toMatchObject({ to: 'ops@example.com', text: md })
    expect(posts[1]!.body.subject).toMatch(/^pleatkit weekly digest: crm, 2 requests, 1 waiting on you$/)
  })
})

// --- C10: bulk carry-over ---

const OLD_TABLE = `export default function DealsTable() { return <table /> }\n`
const ALICE_TABLE = `export default function DealsTable() { return <table className="alice" /> }\n`
const NEW_CARD = BASE_CARD.replace("cn('card')", "cn('card', 'v2')")
const MIGRATED_CARD = GOOD_CARD.replace("cn('card')", "cn('card', 'v2')")

const manifestOf = (card: string): PleatkitManifest => ({
  version: 1,
  dynamicRoots: ['src/dynamic/'],
  dynamic: [
    { path: CARD, source: card },
    { path: TABLE, source: OLD_TABLE },
  ],
  readonly: [{ path: 'src/readonly/api.ts', source: 'export interface Customer { id: string; name: string; meta: Record<string, unknown> }\n' }],
  coreTypes: [{ path: 'src/lib/utils.d.ts', source: 'export declare function cn(...c: unknown[]): string\n' }],
  externals: ['react', 'react/jsx-runtime', '@/lib/utils', '@/readonly/api'],
  externalPatterns: ['react', 'react/jsx-runtime', '@/lib/utils', '@/readonly/*'],
  alias: { '@': 'src' },
})

const MIGRATION: ScriptFixture = {
  name: 'migrate',
  match: ['carry my customizations'],
  turns: [{ calls: [{ tool: 'write_file', input: { path: CARD, content: MIGRATED_CARD }, expect: 'ok' }] }, { calls: [{ tool: 'finish', input: { verdict: 'ok', summary: 'Your phone field is on the new card.' }, expect: 'ok' }] }],
}

const TURN_USAGE: TokenUsage = { inputTokens: 50_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0 }
/** The scripted migration, priced as two Sonnet 5.5 calls, so the budget has something to count. */
function priced(): { provider: ModelProvider; runs: () => number } {
  const inner = new ScriptedProvider([{ ...MIGRATION, dir: '.', patterns: [/carry my customizations/i] }])
  let runs = 0
  return {
    runs: () => runs,
    provider: {
      name: 'scripted',
      model: 'claude-sonnet-5-5',
      classify: (i, s) => inner.classify(i, s),
      start(p, tools, meta) {
        runs++
        const s = inner.start(p, tools, meta)
        return { say: (x) => s.say(x), next: async (r, o) => ({ ...(await s.next(r, o)), model: 'claude-sonnet-5-5', usage: TURN_USAGE }) }
      },
    },
  }
}

async function seedRelease(t: ReturnType<typeof storeSetup>) {
  const old: Record<string, string> = { [CARD]: BASE_CARD, [TABLE]: OLD_TABLE }
  const baseFiles = await fileHashes(old)
  const snap = (id: string, userId: string, parentId: string | null, files: Record<string, string>): Snapshot => ({ id, userId, parentId, files, message: id, author: parentId ? 'agent' : 'base', createdAt: '', status: 'applied', baseHash: 'previous-release', baseFiles })
  // alice changed only the table (the release did not touch it); bob and carol changed the card (the release did)
  await t.put(snap('01A0', 'alice', null, old), false)
  await t.put(snap('01A1', 'alice', '01A0', { ...old, [TABLE]: ALICE_TABLE }), true)
  for (const u of ['bob', 'carol']) {
    await t.put(snap(`01${u}0`, u, null, old), false)
    await t.put(snap(`01${u}1`, u, `01${u}0`, { ...old, [CARD]: GOOD_CARD }), true)
  }
  // dave never edited: nothing to carry
  await t.put(snap('01D0', 'dave', null, old), true)
}

describe('C10: pleatkit carry-over --release <hash> --budget-usd', () => {
  const manifest = manifestOf(NEW_CARD)

  it('refuses a release id that is not the manifest’s', async () => {
    await expect(resolveRelease(manifest, 'deadbeef')).rejects.toThrow(/is not this build/)
    const hash = await manifestReleaseHash(manifest)
    expect(await resolveRelease(manifest, hash.slice(0, 12))).toBe(hash)
  })

  it('carries over without a model where it can, migrates with the agent within the budget, resumes, rolls back', async () => {
    const t = storeSetup()
    await seedRelease(t)
    const hash = await manifestReleaseHash(manifest)
    const one = 2 * costUsd('claude-sonnet-5-5', TURN_USAGE)!
    const p = priced()
    const base = { storeUrl: 'http://store.test', appId: 'crm', manifest, release: hash.slice(0, 12), provider: p.provider, perUserUsd: one * 1.1, fetch: t.fetchVia }

    // budget for one migration and a half: bob goes through, carol waits
    const first = await carryOverRelease({ ...base, budgetUsd: one * 1.5 })
    expect(first.status).toBe('budget')
    expect(first.items.map((i) => `${i.userId}:${i.state}`)).toEqual(['alice:carried', 'bob:migrated', 'carol:budget'])
    expect(first.spentUsd).toBeCloseTo(one, 6)
    expect(p.runs()).toBe(1)

    const head = async (u: string) => ((await (await t.call('GET', `/heads/${u}`, { 'x-pleatkit-user': u })).json()) as { snapshot: Snapshot }).snapshot
    const alice = await head('alice')
    expect(alice).toMatchObject({ parentId: '01A1', message: CARRIED_MESSAGE, author: 'user', baseHash: hash })
    expect(alice.files).toEqual({ [CARD]: NEW_CARD, [TABLE]: ALICE_TABLE })
    const bob = await head('bob')
    expect(bob).toMatchObject({ parentId: '01bob1', author: 'agent', baseHash: hash })
    expect(bob.message).toMatch(/^Carried over to the new version of the app by the agent/)
    expect(bob.files[CARD]).toBe(MIGRATED_CARD)
    expect((await head('carol')).id).toBe('01carol1')

    // resume with more money: only carol runs, the spend so far counts
    const second = await carryOverRelease({ ...base, budgetUsd: one * 3 })
    expect(second.status).toBe('done')
    expect(second.skipped).toBe(2)
    expect(second.items.map((i) => `${i.userId}:${i.state}`)).toEqual(['carol:migrated'])
    expect(second.spentUsd).toBeCloseTo(2 * one, 6)
    expect(p.runs()).toBe(2)
    const run = (await (await t.call('GET', `/admin/releases/${hash.slice(0, 16)}`, t.admin)).json()) as { release: { status: string; spentUsd: number; counts: Record<string, number> } }
    expect(run.release).toMatchObject({ status: 'done', counts: { carried: 1, migrated: 2 } })
    expect(run.release.spentUsd).toBeCloseTo(2 * one, 6)

    // a third run has nothing left to do
    expect((await carryOverRelease({ ...base, budgetUsd: one * 3 })).items).toEqual([])

    // the release is rolled back: every head goes back to the one before the carry-over
    expect(await rollbackRelease({ storeUrl: 'http://store.test', appId: 'crm', release: hash.slice(0, 10), fetch: t.fetchVia })).toEqual({ restored: ['alice', 'bob', 'carol'], kept: [] })
    expect((await head('alice')).id).toBe('01A1')
    expect((await head('bob')).id).toBe('01bob1')
    expect((await head('dave')).id).toBe('01D0')
  })

  it('DECISIONS 70.4: the per-user cap is the perEditUsd of the app’s plan; --per-user-usd overrides it', async () => {
    const hash = await manifestReleaseHash(manifest)
    const one = 2 * costUsd('claude-sonnet-5-5', TURN_USAGE)!
    const run = async (extra: Partial<Parameters<typeof carryOverRelease>[0]>, plan?: { plan: string; limits: Record<string, number> }) => {
      const t = storeSetup()
      await seedRelease(t)
      if (plan) expect((await t.call('PUT', '/admin/plan', t.admin, plan)).status).toBe(200)
      return carryOverRelease({ storeUrl: 'http://store.test', appId: 'crm', manifest, release: hash, provider: priced().provider, budgetUsd: one * 1.5, fetch: t.fetchVia, ...extra })
    }
    // the app's plan allows one migration per user at 1.1 of its cost: bob goes through, carol waits for money
    const byPlan = await run({}, { plan: 'team', limits: { perEditUsd: one * 1.1 } })
    expect(byPlan).toMatchObject({ perUserSource: 'plan', plan: 'team' })
    expect(byPlan.perUserUsd).toBeCloseTo(one * 1.1, 9)
    expect(byPlan.items.map((i) => `${i.userId}:${i.state}`)).toEqual(['alice:carried', 'bob:migrated', 'carol:budget'])
    // the flag wins over the plan: a cap of twice the cost never fits in 1.5
    const byFlag = await run({ perUserUsd: one * 2 }, { plan: 'team', limits: { perEditUsd: one * 1.1 } })
    expect(byFlag).toMatchObject({ perUserSource: 'flag', perUserUsd: one * 2 })
    expect(byFlag.items.map((i) => `${i.userId}:${i.state}`)).toEqual(['alice:carried', 'bob:budget', 'carol:budget'])
    // no plan in the store: the agent's PLEATKIT_PLAN, then free
    expect(await run({ dryRun: true, plan: { name: 'team' } })).toMatchObject({ perUserUsd: 0.5, plan: 'team', perUserSource: 'plan' })
    expect(await run({ dryRun: true })).toMatchObject({ perUserUsd: 0.3, plan: 'free' })
  })

  it('without an agent the conflicting users stay stale; a dry run writes nothing', async () => {
    const t = storeSetup()
    await seedRelease(t)
    const hash = await manifestReleaseHash(manifest)
    const dry = await carryOverRelease({ storeUrl: 'http://store.test', appId: 'crm', manifest, release: hash, budgetUsd: 1, provider: priced().provider, dryRun: true, fetch: t.fetchVia })
    expect(dry.status).toBe('dry-run')
    expect(dry.items.map((i) => `${i.userId}:${i.state}`)).toEqual(['alice:carried', 'bob:migrated', 'carol:migrated'])
    expect(((await (await t.call('GET', '/admin/releases', t.admin)).json()) as unknown[]).length).toBe(0)
    const r = await carryOverRelease({ storeUrl: 'http://store.test', appId: 'crm', manifest, release: hash, budgetUsd: 1, provider: null, fetch: t.fetchVia })
    expect(r.items.map((i) => `${i.userId}:${i.state}`)).toEqual(['alice:carried', 'bob:stale', 'carol:stale'])
    expect(MIGRATE_REQUEST).toMatch(/carry my customizations/i)
  })
})
