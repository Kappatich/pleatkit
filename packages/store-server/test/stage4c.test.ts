import { describe, expect, it } from 'vitest'
import { HttpStore, type Snapshot } from '@pleatkit/runtime'
import { createStoreApp, mintUserToken, openStore } from '../src/index.js'
import { csvField, REPORT_COLUMNS } from '../src/report.js'
import { verifyAuditChain } from '../src/ledger.js'

const SECRET = 's'.repeat(40)
const APP_KEY = 'mk_live_0123456789abcdefghijklmnop'

function setup(options: Parameters<typeof createStoreApp>[1] = {}) {
  const store = openStore()
  const app = createStoreApp(store.db, options)
  const call = (path: string, headers: Record<string, string>, init: RequestInit = {}) =>
    app.request(`http://store.test${path}`, { ...init, headers: { 'content-type': 'application/json', ...headers } })
  const fetchVia = ((input: string | URL | Request, init?: RequestInit) => app.request(input instanceof Request ? input : String(input), init)) as typeof fetch
  const user = (userId: string, extra: Partial<ConstructorParameters<typeof HttpStore>[0]> = {}) => new HttpStore({ baseUrl: 'http://store.test', userId, appId: 'crm', fetch: fetchVia, ...extra })
  const admin = { 'x-pleatkit-admin': '1', 'x-pleatkit-app': 'crm' }
  const support = { 'x-pleatkit-role': 'support', 'x-pleatkit-user': 'carol', 'x-pleatkit-app': 'crm' }
  const agent = (userId: string) => ({ 'x-pleatkit-agent': '1', 'x-pleatkit-user': userId, 'x-pleatkit-app': 'crm' })
  const raw = (store.db as unknown as { $client: { prepare(sql: string): { all(): unknown[] } } }).$client
  const auditRows = () => raw.prepare("SELECT actor, action, object_id AS objectId, details FROM audit WHERE app_id = 'crm' ORDER BY seq").all() as { actor: string; action: string; objectId: string; details: string }[]
  return { app, call, user, admin, support, agent, db: store.db, fetchVia, auditRows }
}

let seq = 0
const snap = (userId: string, parentId: string | null, files: Record<string, string>, extra: Partial<Snapshot> = {}): Snapshot => ({
  id: `01G${String(++seq).padStart(6, '0')}`,
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

/** base -> one agent edit (request logged and linked) as the user's head. */
async function edited(t: ReturnType<typeof setup>, userId: string, card: string, extra: { verdict?: string; usage?: unknown[]; orgId?: string } = {}) {
  const s = t.user(userId, extra.orgId ? { headers: { 'x-pleatkit-org': extra.orgId } } : {})
  const base = snap(userId, null, BASE)
  await s.put(base)
  const res = await t.call('/v1/requests', { ...t.agent(userId), ...(extra.orgId ? { 'x-pleatkit-org': extra.orgId } : {}) }, {
    method: 'POST',
    body: JSON.stringify({ userId, text: `edit by ${userId}`, verdict: extra.verdict ?? 'ok', status: 'proposed', log: [], usage: extra.usage ?? [] }),
  })
  const { id: requestId } = (await res.json()) as { id: string }
  const v1 = snap(userId, base.id, { [CARD]: card }, { requestId })
  await s.put(v1)
  await s.setHead(userId, v1.id)
  await s.linkRequest(requestId, { snapshotId: v1.id, status: 'applied' })
  return { s, base, v1, requestId }
}

describe('C8: support and admin roles', () => {
  it('a support token reads /admin but changes nothing there; the export and the report are admin-only', async () => {
    const t = setup({ auth: { apps: { crm: { appKey: APP_KEY, jwtSecret: SECRET } } } })
    const tok = async (role: 'user' | 'support' | 'admin', userId = 'carol') => ({ authorization: `Bearer ${await mintUserToken({ secret: SECRET, userId, appId: 'crm', role })}` })
    const support = await tok('support')
    expect((await t.call('/v1/admin/requests', support)).status).toBe(200)
    expect((await t.call('/v1/admin/stats', support)).status).toBe(200)
    expect((await t.call('/v1/admin/audit', support)).status).toBe(200)
    expect((await t.call('/v1/admin/export', support)).status).toBe(403)
    expect((await t.call('/v1/report', support)).status).toBe(403)
    expect((await t.call('/v1/admin/settings', support, { method: 'PUT', body: JSON.stringify({ moderation: 'review' }) })).status).toBe(403)
    expect((await t.call('/v1/admin/flags', support, { method: 'PUT', body: JSON.stringify({ scope: 'app', key: 'edits.enabled', value: false }) })).status).toBe(403)
    expect((await t.call('/v1/admin/requests', await tok('user'))).status).toBe(403)
    const admin = await tok('admin')
    expect((await t.call('/v1/admin/flags', admin, { method: 'PUT', body: JSON.stringify({ scope: 'app', key: 'edits.enabled', value: false }) })).status).toBe(200)
    expect((await t.call('/v1/admin/export', admin)).status).toBe(200)
    // an unknown role in a token is refused outright
    const forged = await mintUserToken({ secret: SECRET, userId: 'x', appId: 'crm', role: 'owner' as never })
    expect((await t.call('/v1/admin/requests', { authorization: `Bearer ${forged}` })).status).toBe(401)
  })

  it('impersonation: support sees the user’s version and history; only an admin writes as the user; all audited with both ids', async () => {
    const t = setup({ auth: { apps: { crm: { appKey: APP_KEY, jwtSecret: SECRET } } } })
    const token = (userId: string, role: 'user' | 'support' | 'admin') => mintUserToken({ secret: SECRET, userId, appId: 'crm', role })
    const alice = t.user('alice', { token: await token('alice', 'user') })
    const base = snap('alice', null, BASE)
    await alice.put(base)
    const v1 = snap('alice', base.id, { [CARD]: 'export default () => <div>alice</div>\n' })
    await alice.put(v1)
    await alice.setHead('alice', v1.id)
    const before = t.auditRows().length

    // carol (support) acts as alice: same head, same history
    const asAlice = t.user('alice', { token: await token('carol', 'support'), viewer: 'carol' })
    expect((await asAlice.head('alice'))?.id).toBe(v1.id)
    expect((await asAlice.list('alice')).map((s) => s.id)).toEqual([v1.id, base.id])
    // DECISIONS 70.5: support cannot write as alice (403, and the attempt is audited); nothing moved
    await expect(asAlice.setHead('alice', base.id)).rejects.toThrow(/403/)
    expect((await alice.head('alice'))?.id).toBe(v1.id)
    // an admin restores her original version (a write, as alice)
    const adminAsAlice = t.user('alice', { token: await token('dave', 'admin'), viewer: 'dave' })
    await adminAsAlice.setHead('alice', base.id)
    expect((await alice.head('alice'))?.id).toBe(base.id)

    const rows = t.auditRows().slice(before)
    const imp = rows.filter((r) => r.action.startsWith('impersonate.'))
    expect(imp.map((r) => [r.actor, r.action, JSON.parse(r.details).status])).toEqual([
      ['support:carol:as:alice', 'impersonate.read', 200],
      ['support:carol:as:alice', 'impersonate.read', 200],
      ['support:carol:as:alice', 'impersonate.write', 403],
      ['admin:dave:as:alice', 'impersonate.write', 204],
    ])
    for (const r of imp) expect(JSON.parse(r.details)).toMatchObject({ user: 'alice' })
    // the write's own audit row names both as well
    expect(rows.filter((r) => r.action === 'head.set').map((r) => r.actor)).toEqual(['admin:dave:as:alice'])
    expect(verifyAuditChain(t.db, 'crm').ok).toBe(true)

    // a plain user cannot act as someone else; bob cannot read alice without it either
    const bobAsAlice = t.user('alice', { token: await token('bob', 'user'), viewer: 'bob' })
    await expect(bobAsAlice.head('alice')).rejects.toThrow(/403/)
    const bobToken = await token('bob', 'user')
    expect((await t.call('/v1/heads/alice', { authorization: `Bearer ${bobToken}` })).status).toBe(403)
  })

  it('impersonation with the development headers: x-pleatkit-role support + x-pleatkit-act-as', async () => {
    const t = setup()
    await edited(t, 'alice', 'export default () => <div>a</div>\n')
    const res = await t.call('/v1/heads/alice', { ...t.support, 'x-pleatkit-act-as': 'alice' })
    expect(res.status).toBe(200)
    expect(t.auditRows().at(-1)).toMatchObject({ actor: 'support:carol:as:alice', action: 'impersonate.read', objectId: 'alice' })
    expect((await t.call('/v1/heads/alice', { 'x-pleatkit-user': 'bob', 'x-pleatkit-app': 'crm', 'x-pleatkit-act-as': 'alice' })).status).toBe(403)
  })
})

describe('C9: GET /v1/report', () => {
  it('CSV per day and organization with requests, outcomes, users, cost and carry-overs, plus a total', async () => {
    const t = setup()
    const priced = [{ model: 'claude-sonnet-5-5', calls: 2, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0421 }]
    const a = await edited(t, 'alice', 'export default () => <div>a</div>\n', { usage: priced, orgId: 'acme' })
    await edited(t, 'bob', 'export default () => <div>b</div>\n', { orgId: 'globex' })
    await t.call('/v1/requests', { ...t.agent('dora'), 'x-pleatkit-org': 'acme' }, { method: 'POST', body: JSON.stringify({ userId: 'dora', text: 'discount, server side', verdict: 'needs-backend', status: 'pending-admin', log: [] }) })
    // alice undoes her edit, then a release carries bob's version over
    await a.s.setHead('alice', a.base.id)
    const bob = t.user('bob', { headers: { 'x-pleatkit-org': 'globex' } })
    const head = await bob.head('bob')
    await bob.put(snap('bob', head!.id, { [CARD]: 'export default () => <div>b2</div>\n' }, { message: 'Carried over to the new version of the app', author: 'user' }))

    const res = await t.call('/v1/report?from=2000-01-01&to=2100-01-01', t.admin)
    expect(res.status).toBe(400) // the range is at most 400 days
    const today = new Date().toISOString().slice(0, 10)
    const csvRes = await t.call(`/v1/report?from=${today}&to=${today}`, t.admin)
    expect(csvRes.status).toBe(200)
    expect(csvRes.headers.get('content-type')).toMatch(/text\/csv/)
    expect(csvRes.headers.get('content-disposition')).toContain(`pleatkit-report-crm-${today}-${today}.csv`)
    const lines = (await csvRes.text()).trim().split('\r\n')
    expect(lines[0]).toBe(REPORT_COLUMNS.join(','))
    const rows = lines.slice(1).map((l) => Object.fromEntries(l.split(',').map((v, i) => [REPORT_COLUMNS[i], v])))
    const acme = rows.find((r) => r.org === 'acme')!
    expect(acme).toMatchObject({ date: today, users: '2', requests: '2', ok: '1', needs_backend: '1', applied: '1', reverted_by_user: '1', cost_usd: '0.0421' })
    const globex = rows.find((r) => r.org === 'globex')!
    expect(globex).toMatchObject({ requests: '1', ok: '1', applied: '1', carry_overs: '1', cost_usd: '0' })
    expect(rows.at(-1)).toMatchObject({ date: 'total', org: 'all', orgs: '2', users: '3', requests: '3', carry_overs: '1', cost_usd: '0.0421' })

    const json = (await (await t.call(`/v1/report?from=${today}&to=${today}&format=json`, t.admin)).json()) as { rows: unknown[]; total: { requests: number } }
    expect(json.total.requests).toBe(3)
    expect((await t.call('/v1/report?from=nope', t.admin)).status).toBe(400)
    expect((await t.call('/v1/report', { 'x-pleatkit-user': 'alice', 'x-pleatkit-app': 'crm' })).status).toBe(403)
  })

  it('CSV fields are quoted and defused for spreadsheets', () => {
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvField(-1)).toBe('-1')
  })
})

describe('C9: the wish map in the store', () => {
  it('lists what the zone could not serve and keeps the latest map with counts per cluster', async () => {
    const t = setup()
    const post = (userId: string, text: string, verdict: string, extra: Record<string, unknown> = {}) =>
      t.call('/v1/requests', t.agent(userId), { method: 'POST', body: JSON.stringify({ userId, text, verdict, status: 'pending-admin', log: [], ...extra }) })
    const ids: string[] = []
    for (const [u, text, verdict, extra] of [
      ['alice', 'discount on deals', 'needs-backend', {}],
      ['bob', 'discount per customer', 'needs-backend', {}],
      ['bob', 'rename the app title', 'not-editable', { intentLabel: 'out-of-zone' }],
      ['dora', 'add phone', 'ok', {}],
    ] as const) ids.push(((await (await post(u, text, verdict, extra)).json()) as { id: string }).id)
    const items = (await (await t.call('/v1/admin/wish-items', t.admin)).json()) as { items: { id: string; kind: string }[] }
    expect(items.items.map((i) => i.kind).sort()).toEqual(['needs-backend', 'needs-backend', 'out-of-zone'])
    expect(items.items.some((i) => i.id === ids[3])).toBe(false)

    expect(((await (await t.call('/v1/admin/wishes', t.admin)).json()) as { map: unknown }).map).toBeNull()
    const map = { from: 0, to: Date.now(), provider: 'scripted', model: 'scripted', clusters: [{ panel: 'deals-table', title: 'Discounts on deals', kind: 'needs-backend', requestIds: [ids[0], ids[1]] }, { panel: 'header', title: 'App title', kind: 'out-of-zone', requestIds: [ids[2]] }] }
    expect((await t.call('/v1/admin/wishes', t.admin, { method: 'PUT', body: JSON.stringify(map) })).status).toBe(201)
    const got = (await (await t.call('/v1/admin/wishes', t.support)).json()) as { map: { items: number; clusters: { title: string; requests: number; users: number; examples: string[] }[] } }
    expect(got.map.items).toBe(3)
    expect(got.map.clusters[0]).toMatchObject({ title: 'Discounts on deals', requests: 2, users: 2 })
    expect(got.map.clusters[0]!.examples).toContain('discount on deals')
    expect((await t.call('/v1/admin/wishes', t.support, { method: 'PUT', body: JSON.stringify(map) })).status).toBe(403)
    expect((await t.call('/v1/admin/wishes', t.admin, { method: 'PUT', body: JSON.stringify({ from: 0, to: 1, clusters: [{ title: 1 }] }) })).status).toBe(400)
  })
})

describe('C11: snapshot search and rollback by selection', () => {
  it('?grep= finds the live versions with a string; the rollback needs the confirm count and keeps earlier edits', async () => {
    const t = setup()
    const BAD = '<img src="https://evil.example/x">'
    // alice: base -> good edit -> bad edit (head); bob: base -> bad edit (head); dora: bad edit undone (not live)
    const a = await edited(t, 'alice', 'export default () => <div>phone</div>\n')
    const aBad = snap('alice', a.v1.id, { [CARD]: `export default () => <div>phone${BAD}</div>\n` })
    await a.s.put(aBad)
    await a.s.setHead('alice', aBad.id)
    await edited(t, 'bob', `export default () => <div>${BAD}</div>\n`)
    const d = await edited(t, 'dora', `export default () => <div>${BAD}</div>\n`)
    await d.s.setHead('dora', d.base.id)

    expect((await t.call('/v1/admin/snapshots?grep=x', t.admin)).status).toBe(400)
    const heads = (await (await t.call(`/v1/admin/snapshots?grep=${encodeURIComponent('evil.example')}`, t.support)).json()) as { count: number; rows: { userId: string; isHead: boolean; matches: { file: string; line: number; text: string }[] }[] }
    expect(heads.count).toBe(2)
    expect(heads.rows.map((r) => r.userId).sort()).toEqual(['alice', 'bob'])
    expect(heads.rows[0]!.matches[0]).toMatchObject({ file: CARD, line: 1 })
    expect(heads.rows[0]!.matches[0]!.text).toContain('evil.example')
    const all = (await (await t.call('/v1/admin/snapshots?grep=evil.example&scope=all', t.admin)).json()) as { count: number }
    expect(all.count).toBe(3)

    const rollback = (body: unknown, headers: Record<string, string> = t.admin) => t.call('/v1/admin/snapshots/rollback', headers, { method: 'POST', body: JSON.stringify(body) })
    expect((await rollback({ grep: 'evil.example', confirm: 2 }, t.support)).status).toBe(403)
    const wrong = await rollback({ grep: 'evil.example', confirm: 3 })
    expect(wrong.status).toBe(409)
    expect(await wrong.json()).toMatchObject({ code: 'confirm-count', count: 2 })
    const ok = await rollback({ grep: 'evil.example', confirm: 2 })
    expect(await ok.json()).toEqual({ matched: 2, rolledBack: 2, skipped: [], users: ['alice', 'bob'] })
    // alice keeps her good edit, bob goes back to his original version
    expect((await t.user('alice').head('alice'))?.id).toBe(a.v1.id)
    expect((await t.user('bob').head('bob'))?.parentId).toBeNull()
    expect(((await (await t.call('/v1/admin/snapshots?grep=evil.example', t.admin)).json()) as { count: number }).count).toBe(0)
    expect(t.auditRows().filter((r) => r.action === 'snapshot.rollback-selection').map((r) => r.objectId)).toEqual(['alice', 'bob'])
  })
})

describe('C10: release runs in the store', () => {
  it('records progress and spend, resumes with a new budget, and the rollback restores the previous heads', async () => {
    const t = setup()
    const a = await edited(t, 'alice', 'export default () => <div>a</div>\n')
    const b = await edited(t, 'bob', 'export default () => <div>b</div>\n')
    const R = 'rel-0123456789ab'
    const put = (path: string, body: unknown, headers: Record<string, string> = t.admin) => t.call(`/v1/admin/releases/${R}${path}`, headers, { method: 'PUT', body: JSON.stringify(body) })
    expect((await put('', { budgetUsd: 1 }, t.support)).status).toBe(403)
    expect((await put('/items/alice', { fromSnapshot: a.v1.id, state: 'carried' })).status).toBe(404)
    expect((await put('', { budgetUsd: 1 })).status).toBe(201)

    // alice carried over by the agent (a new head), bob stopped by the budget
    const s = t.user('alice')
    const a2 = snap('alice', a.v1.id, { [CARD]: 'export default () => <div>a2</div>\n' }, { message: 'Carried over by the agent', author: 'agent' })
    await s.put(a2)
    await s.setHead('alice', a2.id)
    expect((await put('/items/alice', { fromSnapshot: a.v1.id, toSnapshot: a2.id, state: 'migrated', costUsd: 0.25 })).status).toBe(200)
    expect((await put('/items/bob', { fromSnapshot: b.v1.id, state: 'budget' })).status).toBe(200)
    expect((await put('/items/bob', { fromSnapshot: a.v1.id, state: 'carried' })).status).toBe(400) // not bob's snapshot
    expect((await put('/items/bob', { fromSnapshot: b.v1.id, state: 'nonsense' })).status).toBe(400)

    // resume: same id, higher budget; what is done comes back
    const resumed = (await (await put('', { budgetUsd: 2 })).json()) as { release: { spentUsd: number; budgetUsd: number; counts: Record<string, number> }; items: { userId: string; state: string }[] }
    expect(resumed.release).toMatchObject({ spentUsd: 0.25, budgetUsd: 2, counts: { migrated: 1, budget: 1 } })
    expect((await t.call(`/v1/admin/releases/${R}/finish`, t.admin, { method: 'POST', body: JSON.stringify({ status: 'done' }) })).status).toBe(200)
    const list = (await (await t.call('/v1/admin/releases', t.support)).json()) as { release: string; status: string }[]
    expect(list).toMatchObject([{ release: R, status: 'done' }])

    const rb = (await (await t.call(`/v1/admin/releases/${R}/rollback`, t.admin, { method: 'POST' })).json()) as { restored: string[]; kept: string[] }
    expect(rb).toEqual({ restored: ['alice'], kept: [] })
    expect((await t.user('alice').head('alice'))?.id).toBe(a.v1.id)
    const after = (await (await t.call(`/v1/admin/releases/${R}`, t.admin)).json()) as { release: { status: string }; items: { userId: string; state: string }[] }
    expect(after.release.status).toBe('rolled-back')
    expect(after.items.find((i) => i.userId === 'alice')?.state).toBe('rolled-back')
    expect((await put('', { budgetUsd: 3 })).status).toBe(409)
  })

  it('a user who edited again after the carry-over keeps the newer version on rollback', async () => {
    const t = setup()
    const a = await edited(t, 'alice', 'export default () => <div>a</div>\n')
    const R = 'rel-kept-000001'
    await t.call(`/v1/admin/releases/${R}`, t.admin, { method: 'PUT', body: JSON.stringify({ budgetUsd: 0 }) })
    const s = t.user('alice')
    const a2 = snap('alice', a.v1.id, { [CARD]: 'export default () => <div>a2</div>\n' }, { message: 'Carried over to the new version of the app', author: 'user' })
    await s.put(a2)
    await s.setHead('alice', a2.id)
    await t.call(`/v1/admin/releases/${R}/items/alice`, t.admin, { method: 'PUT', body: JSON.stringify({ fromSnapshot: a.v1.id, toSnapshot: a2.id, state: 'carried' }) })
    const a3 = snap('alice', a2.id, { [CARD]: 'export default () => <div>a3</div>\n' })
    await s.put(a3)
    await s.setHead('alice', a3.id)
    const rb = (await (await t.call(`/v1/admin/releases/${R}/rollback`, t.admin, { method: 'POST' })).json()) as { restored: string[]; kept: string[] }
    expect(rb).toEqual({ restored: [], kept: ['alice'] })
    expect((await s.head('alice'))?.id).toBe(a3.id)
  })
})
