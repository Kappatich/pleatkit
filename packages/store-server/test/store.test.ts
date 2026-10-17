import { beforeEach, describe, expect, it } from 'vitest'
import { HttpStore, HttpStoreError, type Snapshot } from '@morphkit/runtime'
import { createStoreApp, openStore } from '../src/app.js'

let app: ReturnType<typeof createStoreApp>
const fetchVia = (input: string | URL | Request, init?: RequestInit) => app.request(input instanceof Request ? input : String(input), init)
const storeFor = (userId: string, appId = 'crm') => new HttpStore({ baseUrl: 'http://store.test', userId, appId, fetch: fetchVia as typeof fetch })

const admin = (path: string, init: RequestInit = {}) =>
  app.request(`http://store.test${path}`, { ...init, headers: { 'x-morphkit-admin': '1', 'x-morphkit-app': 'crm', 'content-type': 'application/json', ...(init.headers ?? {}) } })

let seq = 0
const snap = (userId: string, parentId: string | null, label: string, extra: Partial<Snapshot> = {}): Snapshot => ({
  id: `01SNAP${String(++seq).padStart(4, '0')}`,
  parentId,
  userId,
  files: { 'src/dynamic/card.tsx': `export default () => '${label}'` },
  message: label,
  author: parentId ? 'agent' : 'base',
  createdAt: new Date().toISOString(),
  status: 'applied',
  baseHash: 'base-v1',
  ...extra,
})

async function agentLogs(userId: string, body: Record<string, unknown>): Promise<string> {
  const res = await app.request('http://store.test/requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-morphkit-agent': '1', 'x-morphkit-user': userId, 'x-morphkit-app': 'crm' },
    body: JSON.stringify({ userId, text: 'add phone', verdict: 'ok', summary: 'Added.', status: 'proposed', log: [{ tool: 'write_file' }, { tool: 'finish' }], ...body }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { id: string }).id
}

beforeEach(() => {
  app = createStoreApp(openStore().db)
})

describe('HttpStore against store-server (SnapshotStore contract)', () => {
  it('stores snapshots, heads and bundles per user', async () => {
    const alice = storeFor('alice')
    expect(await alice.head('alice')).toBeNull()
    const base = snap('alice', null, 'base')
    const requestId = await agentLogs('alice', {})
    const v1 = snap('alice', base.id, 'v1', { requestId, author: 'agent' })
    await alice.put(base)
    await alice.put(v1)
    await alice.setHead('alice', v1.id)
    // the server stamps createdAt (code review 06 item 7)
    const stamped = (x: Snapshot) => ({ ...x, createdAt: expect.any(String) })
    expect(await alice.head('alice')).toEqual(stamped(v1))
    expect(await alice.get(base.id)).toEqual(stamped(base))
    expect((await alice.list('alice')).map((s) => s.id)).toEqual([v1.id, base.id])

    expect(await alice.bundleCache.get('v2:tailwind:abc')).toBeNull()
    await alice.bundleCache.put('v2:tailwind:abc', { js: 'export const modules = {}', css: '.a{}' })
    expect(await alice.bundleCache.get('v2:tailwind:abc')).toEqual({ js: 'export const modules = {}', css: '.a{}' })
  })

  it('keeps users and apps apart', async () => {
    const alice = storeFor('alice')
    const base = snap('alice', null, 'base')
    await alice.put(base)
    await alice.setHead('alice', base.id)
    const bob = storeFor('bob')
    expect(await bob.head('bob')).toBeNull()
    await expect(bob.get(base.id)).rejects.toThrow(/403/)
    await expect(bob.put({ ...base, userId: 'bob' })).rejects.toBeInstanceOf(HttpStoreError)
    await expect(bob.setHead('bob', base.id)).rejects.toThrow(/403/)
    await expect(bob.head('alice')).rejects.toThrow('bound to user')
    expect(await storeFor('alice', 'other-app').head('alice')).toBeNull()
  })
})

describe('request log and admin actions', () => {
  async function appliedEdit(userId = 'alice') {
    const store = storeFor(userId)
    const base = snap(userId, null, 'base')
    await store.put(base)
    const requestId = await agentLogs(userId, {})
    const v1 = snap(userId, base.id, 'v1', { requestId })
    await store.put(v1)
    await store.setHead(userId, v1.id)
    await store.linkRequest(requestId, { snapshotId: v1.id, status: 'applied' })
    return { store, base, v1, requestId }
  }

  it('links the committed snapshot; admin sees the request, its tool log and the diff base', async () => {
    const { v1, base, requestId } = await appliedEdit()
    const list = (await (await admin('/admin/requests')).json()) as { id: string; status: string; toolCalls: number; isHead: boolean }[]
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: requestId, status: 'applied', toolCalls: 2, isHead: true })
    const detail = (await (await admin(`/admin/requests/${requestId}`)).json()) as { request: { log: unknown[] }; snapshot: Snapshot; parent: Snapshot }
    expect(detail.request.log).toHaveLength(2)
    expect(detail.snapshot.id).toBe(v1.id)
    expect(detail.parent.id).toBe(base.id)
  })

  it('admin rollback moves the user back to the parent snapshot', async () => {
    const { store, base, requestId } = await appliedEdit()
    const res = await admin(`/admin/requests/${requestId}/rollback`, { method: 'POST' })
    expect(await res.json()).toEqual({ status: 'rolled-back' })
    expect((await store.head('alice'))?.id).toBe(base.id)
    // a second rollback is refused: the snapshot is no longer the head
    expect((await admin(`/admin/requests/${requestId}/rollback`, { method: 'POST' })).status).toBe(409)
  })

  it('reject takes a live edit back too; approve takes a needs-backend request into work', async () => {
    const { store, base, requestId } = await appliedEdit()
    expect((await admin(`/admin/requests/${requestId}/reject`, { method: 'POST', body: JSON.stringify({ note: 'not allowed' }) })).status).toBe(200)
    expect((await store.head('alice'))?.id).toBe(base.id)

    const nb = await agentLogs('bob', { verdict: 'needs-backend', status: 'pending-admin', text: 'discount recalculated on the server' })
    const pending = (await (await admin('/admin/requests?status=pending-admin')).json()) as { id: string }[]
    expect(pending.map((r) => r.id)).toEqual([nb])
    expect(await (await admin(`/admin/requests/${nb}/approve`, { method: 'POST' })).json()).toEqual({ status: 'in-progress' })
    expect((await admin(`/admin/requests/${nb}/approve`, { method: 'POST' })).status).toBe(409)
  })

  it('counts edits, success and needs-backend share for the last week', async () => {
    await appliedEdit('alice')
    await agentLogs('bob', { verdict: 'needs-backend', status: 'pending-admin' })
    await agentLogs('bob', { verdict: 'failed', status: 'failed' })
    const stats = (await (await admin('/admin/stats')).json()) as Record<string, unknown>
    expect(stats).toMatchObject({ total: 3, editsThisWeek: 1, byStatus: { applied: 1, 'pending-admin': 1, failed: 1 } })
    expect(stats.successRate).toBeCloseTo(1 / 3)
    expect(stats.needsBackendRate).toBeCloseTo(1 / 3)
  })

  it('admin endpoints need the admin header; users cannot log requests for others', async () => {
    expect((await app.request('http://store.test/admin/requests', { headers: { 'x-morphkit-user': 'alice' } })).status).toBe(403)
    const res = await app.request('http://store.test/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-morphkit-user': 'mallory' },
      body: JSON.stringify({ userId: 'alice', text: 'x' }),
    })
    expect(res.status).toBe(403)
  })
})

describe('moderation: review (DECISIONS 15)', () => {
  async function edit(userId: string, label: string) {
    const store = storeFor(userId)
    const head = await store.head(userId)
    let parent = head
    if (!parent) {
      parent = snap(userId, null, 'base')
      await store.put(parent)
    }
    const requestId = await agentLogs(userId, { text: label })
    const v = snap(userId, parent.id, label, { requestId })
    await store.put(v)
    await store.setHead(userId, v.id)
    const link = await store.linkRequest(requestId, { snapshotId: v.id, status: 'applied' })
    return { store, parent, v, requestId, link }
  }

  it('is off by default: an applied edit is just applied', async () => {
    expect(await storeFor('alice').moderation()).toBe('off')
    const { link } = await edit('alice', 'v1')
    expect(link).toEqual({ status: 'applied' })
  })

  it('review: the edit applies for the user at once, but waits at the top of the admin list until approved', async () => {
    expect(await (await admin('/admin/settings', { method: 'PUT', body: JSON.stringify({ moderation: 'review' }) })).json()).toEqual({ moderation: 'review' })
    expect(await storeFor('alice').moderation()).toBe('review')
    // an older, unrelated request
    await agentLogs('bob', { verdict: 'failed', status: 'failed', text: 'older' })
    const { store, v, requestId, link } = await edit('alice', 'phone')
    expect(link).toEqual({ status: 'pending-review' })
    expect((await store.head('alice'))?.id).toBe(v.id) // applied for the user right away

    const list = (await (await admin('/admin/requests')).json()) as { id: string; status: string; isHead: boolean }[]
    expect(list[0]).toMatchObject({ id: requestId, status: 'pending-review', isHead: true })
    const stats = (await (await admin('/admin/stats')).json()) as Record<string, unknown>
    expect(stats).toMatchObject({ pendingReview: 1, editsThisWeek: 1, moderation: 'review' })

    expect(await (await admin(`/admin/requests/${requestId}/approve`, { method: 'POST' })).json()).toEqual({ status: 'applied' })
    expect((await store.head('alice'))?.id).toBe(v.id)
    expect((await admin(`/admin/requests/${requestId}/approve`, { method: 'POST' })).status).toBe(409)
  })

  it('review: one click rolls the edit back for the user', async () => {
    await admin('/admin/settings', { method: 'PUT', body: JSON.stringify({ moderation: 'review' }) })
    const { store, parent, requestId } = await edit('alice', 'red date')
    expect(await (await admin(`/admin/requests/${requestId}/rollback`, { method: 'POST' })).json()).toEqual({ status: 'rolled-back' })
    expect((await store.head('alice'))?.id).toBe(parent.id)
  })

  it('the setting is per app, validated, and the server-wide default comes from the options', async () => {
    expect((await admin('/admin/settings', { method: 'PUT', body: JSON.stringify({ moderation: 'hold' }) })).status).toBe(400)
    await admin('/admin/settings', { method: 'PUT', body: JSON.stringify({ moderation: 'review' }) })
    expect(await storeFor('alice', 'other-app').moderation()).toBe('off')
    expect((await app.request('http://store.test/admin/settings', { method: 'PUT', headers: { 'x-morphkit-user': 'alice' }, body: '{"moderation":"off"}' })).status).toBe(403)

    app = createStoreApp(openStore().db, { moderation: 'review' })
    expect(await storeFor('alice').moderation()).toBe('review')
    expect(await (await admin('/admin/settings')).json()).toEqual({ moderation: 'review', default: 'review', learning: 'off' })
  })
})

describe('attachments on the request log (stage 3b)', () => {
  it('stores sizes of screenshots and panel DOM, never the images', async () => {
    const id = await agentLogs('alice', { attachments: { images: 1, imageBytes: 54_000, targetDomChars: 1800 } })
    const detail = (await (await admin(`/admin/requests/${id}`)).json()) as { request: { attachments: unknown } }
    expect(detail.request.attachments).toEqual({ images: 1, imageBytes: 54_000, targetDomChars: 1800 })
  })

  it('adds the column to a database created before it existed', async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const Database = (await import('better-sqlite3')).default
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morphkit-store-'))
    const file = path.join(dir, 'old.db')
    const old = new Database(file)
    old.exec(`CREATE TABLE requests (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, user_id TEXT NOT NULL, text TEXT NOT NULL, target TEXT, verdict TEXT NOT NULL,
      summary TEXT NOT NULL, status TEXT NOT NULL, classification TEXT, provider TEXT, model TEXT, usage TEXT, timings TEXT,
      log TEXT NOT NULL, files TEXT, snapshot_id TEXT, error TEXT, admin_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_at_ms INTEGER NOT NULL)`)
    old.close()
    const store = openStore({ file })
    app = createStoreApp(store.db)
    const id = await agentLogs('alice', { attachments: { images: 2, imageBytes: 10, targetDomChars: 0 } })
    expect(((await (await admin(`/admin/requests/${id}`)).json()) as { request: { attachments: { images: number } } }).request.attachments.images).toBe(2)
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
