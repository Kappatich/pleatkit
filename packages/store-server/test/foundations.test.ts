import { describe, expect, it } from 'vitest'
import { HttpStore, type Snapshot } from '@pleatkit/runtime'
import { createStoreApp, mintUserToken, openStore } from '../src/index.js'
import { sweepAlive24h, verifyAuditChain } from '../src/ledger.js'

const SECRET = 's'.repeat(40)
const APP_KEY = 'mk_live_0123456789abcdefghijklmnop'

function setup(options: Parameters<typeof createStoreApp>[1] = {}) {
  const store = openStore()
  const app = createStoreApp(store.db, { region: 'eu-1', environment: 'staging', ...options })
  const call = (path: string, headers: Record<string, string>, init: RequestInit = {}) =>
    app.request(`http://store.test${path}`, { ...init, headers: { 'content-type': 'application/json', ...headers } })
  const fetchVia = (input: string | URL | Request, init?: RequestInit) => app.request(input instanceof Request ? input : String(input), init)
  const user = (userId: string, appId = 'crm') => new HttpStore({ baseUrl: 'http://store.test', userId, appId, fetch: fetchVia as typeof fetch })
  const as = (userId: string) => ({ 'x-pleatkit-user': userId, 'x-pleatkit-app': 'crm' })
  const admin = { 'x-pleatkit-admin': '1', 'x-pleatkit-app': 'crm' }
  const agent = (userId: string) => ({ 'x-pleatkit-agent': '1', 'x-pleatkit-user': userId, 'x-pleatkit-app': 'crm' })
  const raw = (store.db as unknown as { $client: { prepare(sql: string): { all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown } ; exec(sql: string): void } }).$client
  return { app, call, user, as, admin, agent, db: store.db, raw }
}

let seq = 0
const snap = (userId: string, parentId: string | null, extra: Partial<Snapshot> = {}): Snapshot => ({
  id: `01F${String(++seq).padStart(5, '0')}`,
  parentId,
  userId,
  files: { 'src/dynamic/card.tsx': `export default () => ${seq}` },
  message: `v${seq}`,
  author: parentId ? 'agent' : 'base',
  createdAt: new Date().toISOString(),
  status: 'applied',
  ...extra,
})

/** base -> agent edit (logged, linked as applied) for a user. */
async function appliedEdit(t: ReturnType<typeof setup>, userId = 'alice') {
  const s = t.user(userId)
  const base = snap(userId, null)
  await s.put(base)
  const res = await t.call('/v1/requests', t.agent(userId), { method: 'POST', body: JSON.stringify({ userId, text: 'phone', verdict: 'ok', status: 'proposed', log: [], promptVersion: 'p1' }) })
  const { id: requestId } = (await res.json()) as { id: string }
  const v1 = snap(userId, base.id, { requestId, baseFiles: { 'src/dynamic/card.tsx': 'abc' }, schemaVersion: 2 })
  await s.put(v1)
  await s.setHead(userId, v1.id)
  await s.linkRequest(requestId, { snapshotId: v1.id, status: 'applied' })
  return { s, base, v1, requestId }
}

describe('F1/F2/F4: tenant, placement and versions on every record', () => {
  it('rows carry org, region and environment; snapshots keep per-file base hashes and their schema version', async () => {
    const t = setup({ auth: { apps: { crm: { appKey: APP_KEY, jwtSecret: SECRET } }, demoHeaders: true } })
    const token = await mintUserToken({ secret: SECRET, userId: 'alice', appId: 'crm', orgId: 'acme', environment: 'production' })
    const s = new HttpStore({ baseUrl: 'http://store.test', userId: 'alice', appId: 'crm', token, fetch: ((i: string, init?: RequestInit) => t.app.request(i, init)) as typeof fetch })
    const v = snap('alice', null, { baseFiles: { a: '1' }, schemaVersion: 2 })
    await s.put(v)
    expect(await s.get(v.id)).toEqual({ ...v, createdAt: expect.any(String) })
    const row = t.raw.prepare('SELECT org_id, region, environment, schema_version FROM snapshots WHERE id = ?').all(v.id)[0]
    expect(row).toEqual({ org_id: 'acme', region: 'eu-1', environment: 'production', schema_version: 2 })
    const req = await t.call('/v1/requests', { authorization: `Bearer ${APP_KEY}`, 'x-pleatkit-user': 'alice', 'x-pleatkit-org': 'acme' }, { method: 'POST', body: JSON.stringify({ userId: 'alice', text: 'x', log: [], promptVersion: '2026-10-18.4a' }) })
    const { id } = (await req.json()) as { id: string }
    expect(t.raw.prepare('SELECT org_id, region, environment, prompt_version FROM requests WHERE id = ?').all(id)[0]).toEqual({
      org_id: 'acme',
      region: 'eu-1',
      environment: 'staging',
      prompt_version: '2026-10-18.4a',
    })
  })
})

describe('F3: append-only usage events', () => {
  it('store writes edit.applied, edit.reverted (user undo, admin rollback) and editor.active once a day', async () => {
    const t = setup()
    const { s, base, requestId } = await appliedEdit(t)
    await s.setHead('alice', base.id) // the user undid it
    const second = await appliedEdit(t, 'bob')
    expect((await t.call(`/v1/admin/requests/${second.requestId}/rollback`, t.admin, { method: 'POST' })).status).toBe(200)
    // a second request the same day: still one editor.active
    await t.call('/v1/requests', t.agent('alice'), { method: 'POST', body: JSON.stringify({ userId: 'alice', text: 'again', log: [] }) })
    const ev = (await (await t.call('/v1/admin/events', t.admin)).json()) as { type: string; userId: string; requestId: string | null; props: { by?: string } | null; region: string; environment: string }[]
    const of = (type: string) => ev.filter((e) => e.type === type)
    expect(of('edit.applied').map((e) => e.requestId).sort()).toEqual([requestId, second.requestId].sort())
    expect(of('edit.reverted').map((e) => `${e.userId}:${e.props?.by}`).sort()).toEqual(['alice:user', 'bob:admin'])
    expect(of('editor.active').map((e) => e.userId).sort()).toEqual(['alice', 'bob'])
    expect(ev[0]).toMatchObject({ region: 'eu-1', environment: 'staging' })
  })

  it('the agent appends tokens.used and cost.usd; retries with the same dedupe key count once; rows cannot be changed', async () => {
    const t = setup()
    const batch = { events: [{ type: 'cost.usd', value: 0.04, unit: 'usd', userId: 'alice', dedupeKey: 'cost.usd:k1' }, { type: 'tokens.used', value: 1234, unit: 'token', userId: 'alice', dedupeKey: 'tokens.used:k1:m', props: { model: 'm' } }] }
    expect(await (await t.call('/v1/events', t.agent('alice'), { method: 'POST', body: JSON.stringify(batch) })).json()).toEqual({ stored: 2 })
    expect(await (await t.call('/v1/events', t.agent('alice'), { method: 'POST', body: JSON.stringify(batch) })).json()).toEqual({ stored: 0 })
    expect((await t.call('/v1/events', t.as('alice'), { method: 'POST', body: JSON.stringify(batch) })).status).toBe(403)
    expect((await t.call('/v1/events', t.agent('alice'), { method: 'POST', body: JSON.stringify({ events: [{ type: 'free.money', value: 1, unit: 'usd' }] }) })).status).toBe(400)
    expect(() => t.raw.exec('UPDATE events SET value = 0')).toThrow(/append-only/)
    expect(() => t.raw.exec('DELETE FROM events')).toThrow(/append-only/)
  })

  it('edit.alive24h: applied edits still in the user version after 24 h, once each', async () => {
    const t = setup()
    await appliedEdit(t, 'alice')
    const undone = await appliedEdit(t, 'bob')
    await undone.s.setHead('bob', undone.base.id)
    const later = Date.now() + 25 * 60 * 60 * 1000
    expect(sweepAlive24h(t.db, { region: 'eu-1', environment: 'staging' }, Date.now())).toBe(0) // not 24 h yet
    expect(sweepAlive24h(t.db, { region: 'eu-1', environment: 'staging' }, later)).toBe(1)
    expect(sweepAlive24h(t.db, { region: 'eu-1', environment: 'staging' }, later)).toBe(0)
  })
})

describe('F5: Idempotency-Key on writes', () => {
  it('a retried write returns the first response; the same key with another body is refused', async () => {
    const t = setup()
    const post = (body: unknown, key = 'run:abc') => t.call('/v1/requests', { ...t.agent('alice'), 'idempotency-key': key }, { method: 'POST', body: JSON.stringify(body) })
    const body = { userId: 'alice', text: 'x', log: [] }
    const first = await post(body)
    const again = await post(body)
    expect(again.headers.get('idempotent-replayed')).toBe('true')
    expect(await again.json()).toEqual(await first.json())
    expect(t.raw.prepare('SELECT count(*) AS n FROM requests').all()[0]).toEqual({ n: 1 })
    expect((await post({ ...body, text: 'other' })).status).toBe(422)
    // another caller may use the same key for its own request
    expect((await t.call('/v1/requests', { ...t.agent('bob'), 'idempotency-key': 'run:abc' }, { method: 'POST', body: JSON.stringify({ ...body, userId: 'bob' }) })).status).toBe(201)
  })
})

describe('F6: flags and the kill switch', () => {
  it('defaults < app < org < user; the runtime reads them through HttpStore', async () => {
    const t = setup()
    const put = (b: unknown) => t.call('/v1/admin/flags', t.admin, { method: 'PUT', body: JSON.stringify(b) })
    expect(await t.user('alice').flags()).toEqual({ 'pleatkit.enabled': true, 'edits.enabled': true })
    await put({ scope: 'app', key: 'edits.enabled', value: false })
    await put({ scope: 'user', scopeId: 'bob', key: 'edits.enabled', value: true })
    await put({ scope: 'org', scopeId: 'acme', key: 'pleatkit.enabled', value: false })
    expect((await t.user('alice').flags())['edits.enabled']).toBe(false)
    expect((await t.user('bob').flags())['edits.enabled']).toBe(true)
    const orgAlice = (await (await t.call('/v1/flags?userId=alice&orgId=acme', t.agent('alice'))).json()) as { flags: Record<string, unknown> }
    expect(orgAlice.flags['pleatkit.enabled']).toBe(false)
    expect((await put({ scope: 'user', key: 'x', value: 1 })).status).toBe(400)
    await put({ scope: 'app', key: 'edits.enabled', value: null })
    expect((await t.user('alice').flags())['edits.enabled']).toBe(true)
    expect((await t.call('/v1/admin/flags', t.as('alice'), { method: 'PUT', body: '{}' })).status).toBe(403)
  })
})

describe('F7: audit with a hash chain', () => {
  it('records who did what, verifies the chain and detects a changed row', async () => {
    const t = setup()
    const { requestId } = await appliedEdit(t)
    await t.call(`/v1/admin/requests/${requestId}/rollback`, t.admin, { method: 'POST' })
    const { rows, verify } = (await (await t.call('/v1/admin/audit?verify=1', t.admin)).json()) as { rows: { action: string; actor: string }[]; verify: { ok: boolean; rows: number } }
    expect(verify).toMatchObject({ ok: true })
    const actions = rows.map((r) => r.action)
    for (const a of ['snapshot.create', 'request.create', 'head.set', 'request.link', 'request.rollback']) expect(actions).toContain(a)
    expect(rows.find((r) => r.action === 'request.rollback')?.actor).toBe('admin')
    expect(rows.find((r) => r.action === 'head.set')?.actor).toBe('user:alice')
    expect(() => t.raw.exec("UPDATE audit SET actor = 'nobody'")).toThrow(/append-only/)
    // someone with direct database access drops the guard and edits history: the chain no longer verifies
    t.raw.exec('DROP TRIGGER audit_append_only_u')
    t.raw.exec("UPDATE audit SET actor = 'nobody' WHERE action = 'request.rollback'")
    expect(verifyAuditChain(t.db, 'crm')).toMatchObject({ ok: false })
  })
})

describe('F9: export of an app or one user', () => {
  it('returns snapshots with files, requests, events; a user export holds only that user; the export is audited', async () => {
    const t = setup()
    await appliedEdit(t, 'alice')
    await appliedEdit(t, 'bob')
    const all = (await (await t.call('/v1/admin/export', t.admin)).json()) as { format: number; snapshots: { userId: string; files: unknown }[]; requests: unknown[]; events: unknown[]; audit: unknown[] }
    expect(all.format).toBe(1)
    expect(new Set(all.snapshots.map((s) => s.userId))).toEqual(new Set(['alice', 'bob']))
    expect(all.snapshots[0]?.files).toBeTruthy()
    expect(all.audit.length).toBeGreaterThan(5)
    const one = (await (await t.call('/v1/admin/export?userId=alice', t.admin)).json()) as { snapshots: { userId: string }[]; audit?: unknown; requests: { userId: string }[] }
    expect(one.snapshots.every((s) => s.userId === 'alice')).toBe(true)
    expect(one.requests.every((r) => r.userId === 'alice')).toBe(true)
    expect(one.audit).toBeUndefined()
    expect((await t.call('/v1/admin/export', t.as('alice'))).status).toBe(403)
    const audit = (await (await t.call('/v1/admin/audit', t.admin)).json()) as { rows: { action: string }[] }
    expect(audit.rows[0]?.action).toBe('export')
  })
})

describe('migrations', () => {
  it('adds the Stage 4a columns to a database made before them', async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const Database = (await import('better-sqlite3')).default
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleatkit-store-'))
    const file = path.join(dir, 'old.db')
    const old = new Database(file)
    old.exec(`CREATE TABLE snapshots (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, user_id TEXT NOT NULL, parent_id TEXT, files TEXT NOT NULL,
      message TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, base_hash TEXT, request_id TEXT);
      CREATE TABLE heads (app_id TEXT NOT NULL, user_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (app_id, user_id));
      INSERT INTO snapshots VALUES ('01OLD', 'crm', 'alice', NULL, '{}', 'old', 'base', '2026-01-01', 'applied', NULL, NULL);`)
    old.close()
    const store = openStore({ file })
    const app = createStoreApp(store.db)
    const s = new HttpStore({ baseUrl: 'http://store.test', userId: 'alice', appId: 'crm', fetch: ((i: string, init?: RequestInit) => app.request(i, init)) as typeof fetch })
    expect((await s.get('01OLD')).schemaVersion).toBeUndefined()
    await s.setHead('alice', '01OLD')
    expect((await s.head('alice'))?.id).toBe('01OLD')
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
