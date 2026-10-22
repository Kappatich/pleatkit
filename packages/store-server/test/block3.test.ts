import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { HttpStore, type Snapshot } from '@pleatkit/runtime'
import { hashFiles, sriDigest } from '@pleatkit/runtime/compiler'
import { createStoreApp, loadExtensions, mintUserToken, openStore, planErasure, type StoreExtension } from '../src/index.js'
import { verifyAuditChain } from '../src/ledger.js'

const SECRET = 's'.repeat(40)
const APP_KEY = 'mk_live_0123456789abcdefghijklmnop'

function setup(options: Parameters<typeof createStoreApp>[1] = {}) {
  const store = openStore()
  const app = createStoreApp(store.db, options)
  const call = (p: string, headers: Record<string, string>, init: RequestInit = {}) => app.request(`http://store.test${p}`, { ...init, headers: { 'content-type': 'application/json', ...headers } })
  const fetchVia = ((input: string | URL | Request, init?: RequestInit) => app.request(input instanceof Request ? input : String(input), init)) as typeof fetch
  const user = (userId: string) => new HttpStore({ baseUrl: 'http://store.test', userId, appId: 'crm', fetch: fetchVia })
  const admin = { 'x-pleatkit-admin': '1', 'x-pleatkit-app': 'crm' }
  const agent = (userId: string) => ({ 'x-pleatkit-agent': '1', 'x-pleatkit-user': userId, 'x-pleatkit-app': 'crm' })
  const raw = (store.db as unknown as { $client: { prepare(sql: string): { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown } } }).$client
  const count = (table: string, where = "app_id = 'crm'") => (raw.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n
  const auditRows = () => raw.prepare("SELECT actor, action, object_type AS objectType, object_id AS objectId, details FROM audit WHERE app_id = 'crm' ORDER BY seq").all() as { actor: string; action: string; objectType: string; objectId: string; details: string }[]
  return { app, call, user, admin, agent, db: store.db, count, auditRows }
}

let seq = 0
const snap = (userId: string, parentId: string | null, files: Record<string, string>, extra: Partial<Snapshot> = {}): Snapshot => ({
  id: `01H${String(++seq).padStart(6, '0')}`,
  parentId,
  userId,
  files,
  message: `v${seq}`,
  author: parentId ? 'agent' : 'base',
  createdAt: new Date().toISOString(),
  status: 'applied',
  ...extra,
})
const CARD = 'src/dynamic/card.tsx'
const BASE = { [CARD]: 'export default () => <div>card</div>\n' }

/** A user with a base, one logged and linked agent edit as the head, a signed bundle of it, a user flag and a bucket. */
async function populate(t: ReturnType<typeof setup>, userId: string) {
  const s = t.user(userId)
  const base = snap(userId, null, BASE)
  await s.put(base)
  const { id: requestId } = (await (await t.call('/v1/requests', t.agent(userId), { method: 'POST', body: JSON.stringify({ userId, text: `secret wish of ${userId}`, verdict: 'ok', status: 'proposed', log: [] }) })).json()) as { id: string }
  const files = { [CARD]: `export default () => <div>${userId}</div>\n` }
  const v1 = snap(userId, base.id, files, { requestId })
  await s.put(v1)
  await s.setHead(userId, v1.id)
  await s.linkRequest(requestId, { snapshotId: v1.id, status: 'applied' })
  const key = (await hashFiles(files)).slice(0, 40).replace(/[^0-9a-f]/g, 'a')
  const js = `export const modules = {} // ${userId}`
  const payload = { v: 1, app: 'crm', key, filesHash: await hashFiles(files), js: await sriDigest(js), css: await sriDigest(''), externals: [], compiler: 'c', createdAt: new Date().toISOString() }
  expect((await t.call(`/v1/bundles/${key}`, t.agent(userId), { method: 'PUT', body: JSON.stringify({ js, css: '', signature: { payload } }) })).status).toBe(204)
  expect((await t.call(`/v1/bundles/browser-${userId}`, { 'x-pleatkit-user': userId, 'x-pleatkit-app': 'crm' }, { method: 'PUT', body: JSON.stringify({ js, css: '' }) })).status).toBe(204)
  await t.call('/v1/admin/flags', t.admin, { method: 'PUT', body: JSON.stringify({ scope: 'user', scopeId: userId, key: 'edits.enabled', value: false }) })
  await t.call('/v1/quota', t.agent(userId), { method: 'POST', body: JSON.stringify({ ops: [{ op: 'take', key: `user:${userId}:edits`, capacity: 10, refillPerSec: 0, amount: 1 }] }) })
  await t.call('/v1/events', t.agent(userId), { method: 'POST', body: JSON.stringify({ events: [{ type: 'cost.usd', value: 0.02, unit: 'usd', userId, requestId }] }) })
  return { requestId, key, base, v1 }
}

describe('DECISIONS 70.2: erasure of a user and of an app', () => {
  it('DELETE /v1/admin/users/:id needs a confirm token for the counts it shows, then erases everything of the user and nothing of others', async () => {
    const t = setup()
    const alice = await populate(t, 'alice')
    const bob = await populate(t, 'bob')
    const first = await t.call('/v1/admin/users/alice', t.admin, { method: 'DELETE' })
    expect(first.status).toBe(409)
    const plan = (await first.json()) as { code: string; confirm: string; counts: Record<string, number> }
    expect(plan.code).toBe('confirm-required')
    expect(plan.counts).toMatchObject({ snapshots: 2, heads: 1, requests: 1, bundles_owned: 1, bundles_signed: 1, flags: 1, quota_buckets: 1 })
    expect(plan.counts.events).toBeGreaterThanOrEqual(2) // editor.active, edit.applied, cost.usd
    expect(t.count('snapshots', "user_id = 'alice'")).toBe(2) // the plan wrote nothing
    expect((await t.call('/v1/admin/users/alice?confirm=nope', t.admin, { method: 'DELETE' })).status).toBe(409)

    const res = await t.call(`/v1/admin/users/alice?confirm=${plan.confirm}`, t.admin, { method: 'DELETE' })
    expect(res.status).toBe(200)
    const done = (await res.json()) as { erased: boolean; tombstone: string; counts: Record<string, number> }
    expect(done.counts).toEqual(plan.counts)
    for (const [table, where] of [
      ['snapshots', "user_id = 'alice'"],
      ['heads', "user_id = 'alice'"],
      ['requests', "user_id = 'alice'"],
      ['events', `user_id = 'alice' OR request_id = '${alice.requestId}'`],
      ['bundle_files', `owner = 'alice' OR key = '${alice.key}'`],
      ['flags', "scope_id = 'alice'"],
      ['quota_buckets', "key LIKE 'user:alice:%'"],
    ] as const) expect(t.count(table, `app_id = 'crm' AND (${where})`), table).toBe(0)
    // bob keeps everything
    expect((await t.user('bob').head('bob'))?.id).toBe(bob.v1.id)
    expect(t.count('requests', "user_id = 'bob'")).toBe(1)
    expect(t.count('bundle_files', `key = '${bob.key}'`)).toBe(1)
    // the open core has no tables of the cloud's (its erasure counts come from the extensions' hooks)
    expect(Object.keys(plan.counts).filter((k) => /wish|release/.test(k))).toEqual([])

    // the tombstone: an audit row with counts and a random id, nothing that names alice; the chain still verifies
    const tomb = t.auditRows().at(-1)!
    expect(tomb).toMatchObject({ action: 'erase.user', objectType: 'user', objectId: done.tombstone, actor: 'admin' })
    expect(done.tombstone).toMatch(/^erased:[0-9a-f]{16}$/)
    expect(`${tomb.objectId} ${tomb.details}`).not.toMatch(/alice/)
    expect(verifyAuditChain(t.db, 'crm').ok).toBe(true)
    // events stay append-only outside an erasure
    const raw = (t.db as unknown as { $client: { prepare(sql: string): { run(): unknown } } }).$client
    expect(() => raw.prepare("DELETE FROM events WHERE app_id = 'crm'").run()).toThrow(/append-only/)
    expect(() => raw.prepare("DELETE FROM audit WHERE app_id = 'crm'").run()).toThrow(/append-only/)
  })

  it('admin only: users get 403, other roles and acting as a user are cloud features (403)', async () => {
    const t = setup({ auth: { apps: { crm: { appKey: APP_KEY, jwtSecret: SECRET } } } })
    const tok = async (role: 'user' | 'support' | 'admin', userId = 'carol') => ({ authorization: `Bearer ${await mintUserToken({ secret: SECRET, userId, appId: 'crm', role })}` })
    expect((await t.call('/v1/admin/users/alice', await tok('support'), { method: 'DELETE' })).status).toBe(403)
    expect((await t.call('/v1/admin/users/alice', await tok('user', 'alice'), { method: 'DELETE' })).status).toBe(403)
    expect((await t.call('/v1/admin/apps/crm', await tok('support'), { method: 'DELETE' })).status).toBe(403)
    const actAs = await t.call('/v1/admin/users/alice', { ...(await tok('admin')), 'x-pleatkit-act-as': 'alice' }, { method: 'DELETE' })
    expect(actAs.status).toBe(403)
    expect(((await actAs.json()) as { code: string }).code).toBe('cloud-feature')
    expect((await t.call('/v1/admin/users/alice', await tok('admin'), { method: 'DELETE' })).status).toBe(409)
    expect((await t.call('/v1/admin/apps/other', { authorization: `Bearer ${APP_KEY}` }, { method: 'DELETE' })).status).toBe(403)
  })

  it('DELETE /v1/admin/apps/:id erases every row of the app; a new audit chain starts with the tombstone; other apps keep theirs', async () => {
    const t = setup()
    await populate(t, 'alice')
    await populate(t, 'bob')
    await t.call('/v1/admin/plan', t.admin, { method: 'PUT', body: JSON.stringify({ plan: 'team', limits: {} }) })
    await t.call('/v1/requests', { 'x-pleatkit-agent': '1', 'x-pleatkit-user': 'zed', 'x-pleatkit-app': 'other' }, { method: 'POST', body: JSON.stringify({ userId: 'zed', text: 'x', verdict: 'ok', status: 'proposed', log: [] }) })
    const plan = await planErasure(t.db, { appId: 'crm', userId: null })
    expect(plan.counts).toMatchObject({ snapshots: 4, heads: 2, requests: 2, app_plans: 1 })
    expect(plan.counts.audit).toBeGreaterThan(10)
    const res = await t.call(`/v1/admin/apps/crm?confirm=${plan.confirm}`, t.admin, { method: 'DELETE' })
    expect(res.status).toBe(200)
    for (const table of ['snapshots', 'heads', 'requests', 'events', 'bundle_files', 'flags', 'quota_buckets', 'app_plans', 'idempotency', 'erasing']) expect(t.count(table), table).toBe(0)
    const rows = t.auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'erase.app', objectType: 'app' })
    expect(verifyAuditChain(t.db, 'crm')).toEqual({ ok: true, rows: 1, brokenAt: null })
    expect(t.count('requests', "app_id = 'other'")).toBe(1)
    expect(verifyAuditChain(t.db, 'other').ok).toBe(true)
  })

  it('an extension erases its own rows in the same transaction, and its counts are part of the confirm', async () => {
    const seen: string[] = []
    const ext: StoreExtension = {
      name: 'probe',
      count: (_db, s) => ({ rows: s.userId ? 3 : 7 }),
      erase: (_db, s) => (seen.push(`${s.appId}:${s.userId}`), { rows: s.userId ? 3 : 7 }),
    }
    const t = setup({ extensions: [ext] })
    await populate(t, 'alice')
    const plan = (await (await t.call('/v1/admin/users/alice', t.admin, { method: 'DELETE' })).json()) as { confirm: string; counts: Record<string, number> }
    expect(plan.counts['probe:rows']).toBe(3)
    const done = (await (await t.call(`/v1/admin/users/alice?confirm=${plan.confirm}`, t.admin, { method: 'DELETE' })).json()) as { counts: Record<string, number> }
    expect(done.counts['probe:rows']).toBe(3)
    expect(seen).toEqual(['crm:alice'])
  })
})

describe('DECISIONS 70.1: the open core', () => {
  it('runs without extensions; the binary finds no cloud package next to the open store', async () => {
    const here = path.resolve(import.meta.dirname, '..')
    expect(await loadExtensions({}, here)).toEqual({ extensions: [], modules: [] })
    await expect(loadExtensions({ PLEATKIT_STORE_EXTENSIONS: '@pleatkit/no-such-module' }, here)).rejects.toThrow(/cannot find/)
  })

  it('extension hooks: routes behind the core auth, settings, request and outcome hooks, DDL', async () => {
    const calls: string[] = []
    const ext: StoreExtension = {
      name: 'probe',
      ddl: 'CREATE TABLE IF NOT EXISTS probe_rows (id TEXT PRIMARY KEY);',
      routes: (api, ctx) => {
        api.get('/admin/probe', (c) => c.json({ ok: true, app: c.get('caller').appId }))
        api.put('/admin/probe', (c) => (ctx.audited(c.get('caller'), 'probe.set', 'app', 'crm'), c.json({ ok: true })))
      },
      settings: () => ({ probe: 1 }),
      onRequestLogged: (_db, r) => void calls.push(`logged:${r.userId}:${r.verdict}`),
      onOutcome: (_db, id, o) => void calls.push(`outcome:${o}:${id.slice(0, 4)}`),
    }
    const t = setup({ extensions: [ext] })
    expect(await (await t.call('/v1/admin/probe', t.admin)).json()).toEqual({ ok: true, app: 'crm' })
    expect((await t.call('/v1/admin/probe', { 'x-pleatkit-user': 'alice', 'x-pleatkit-app': 'crm' })).status).toBe(403)
    expect(await (await t.call('/v1/admin/settings', t.admin)).json()).toEqual({ moderation: 'off', default: 'off', probe: 1 })
    const { requestId, base } = await populate(t, 'alice')
    await t.user('alice').setHead('alice', base.id)
    expect(calls).toEqual(['logged:alice:ok', `outcome:reverted:user:${requestId.slice(0, 4)}`])
    expect(t.count('probe_rows', '1 = 1')).toBe(0)
  })
})
