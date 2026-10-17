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
    const v1 = snap('alice', base.id, 'v1', { requestId: 'r1' })
    await alice.put(base)
    await alice.put(v1)
    await alice.setHead('alice', v1.id)
    expect(await alice.head('alice')).toEqual(v1)
    expect(await alice.get(base.id)).toEqual(base)
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
