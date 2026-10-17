import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { HeadConflictError, HttpStore, newAppKey, type Snapshot } from '@morphkit/runtime'
import { createStoreApp, openStore } from '../src/app.js'

function setup(options: Parameters<typeof createStoreApp>[1] = {}) {
  const { db } = openStore()
  const app = createStoreApp(db, options)
  const fetchVia = ((input: string | URL | Request, init?: RequestInit) => app.request(input instanceof Request ? input : String(input), init)) as typeof fetch
  const store = (userId: string, appId = 'crm') => new HttpStore({ baseUrl: 'http://store.test', userId, appId, fetch: fetchVia })
  const call = (p: string, headers: Record<string, string>, init: RequestInit = {}) => app.request(`http://store.test${p}`, { ...init, headers: { 'content-type': 'application/json', ...headers } })
  return { app, db, store, call }
}

let n = 0
const snap = (userId: string, parentId: string | null, label: string, extra: Partial<Snapshot> = {}): Snapshot => ({
  id: `01S4B${String(++n).padStart(5, '0')}`,
  parentId,
  userId,
  files: { 'src/dynamic/card.tsx': `export default () => '${label}'` },
  message: label,
  author: parentId ? 'user' : 'base',
  createdAt: '2000-01-01T00:00:00.000Z',
  status: 'applied',
  ...extra,
})

describe('code review 06 §2 test 5: snapshots are insert-only, keyed by (app, id), bodies are limited', () => {
  it('a snapshot cannot be overwritten; a retry with the same content is fine', async () => {
    const t = setup()
    const alice = t.store('alice')
    const base = snap('alice', null, 'base')
    await alice.put(base)
    await alice.put(base) // a retry without an idempotency key
    const res = await t.call(`/v1/snapshots/${base.id}`, { 'x-morphkit-user': 'alice', 'x-morphkit-app': 'crm' }, { method: 'PUT', body: JSON.stringify({ ...base, files: { 'src/dynamic/card.tsx': 'evil' } }) })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('immutable')
    expect((await alice.get(base.id)).files).toEqual(base.files)
  })

  it('the server decides createdAt, status and who the author is', async () => {
    const t = setup()
    const alice = t.store('alice')
    const base = snap('alice', null, 'base', { author: 'agent' })
    await alice.put(base)
    const forged = snap('alice', base.id, 'x', { author: 'admin', status: 'pending-admin' as Snapshot['status'] })
    await alice.put(forged)
    expect(await alice.get(base.id)).toMatchObject({ author: 'base' })
    const got = await alice.get(forged.id)
    expect(got).toMatchObject({ author: 'user', status: 'applied' })
    expect(got.createdAt).not.toBe('2000-01-01T00:00:00.000Z')
  })

  it('the same id in another app is another row; the first app keeps its own', async () => {
    const t = setup()
    const a = t.store('alice', 'crm')
    const b = t.store('alice', 'shop')
    const s1 = snap('alice', null, 'crm')
    await a.put(s1)
    await b.put({ ...s1, files: { 'src/dynamic/card.tsx': 'shop' } })
    expect((await a.get(s1.id)).files['src/dynamic/card.tsx']).toContain('crm')
    expect((await b.get(s1.id)).files['src/dynamic/card.tsx']).toBe('shop')
  })

  it('refuses a body above the limit with 413 (after authentication)', async () => {
    const t = setup({ bodyLimitBytes: 10_000 })
    const big = snap('alice', null, 'big', { files: { 'src/dynamic/card.tsx': 'x'.repeat(20_000) } })
    const res = await t.call(`/v1/snapshots/${big.id}`, { 'x-morphkit-user': 'alice', 'x-morphkit-app': 'crm' }, { method: 'PUT', body: JSON.stringify(big) })
    expect(res.status).toBe(413)
    // without credentials: 401 before the body is read
    const secured = setup({ bodyLimitBytes: 10_000, auth: { apps: { crm: { appKey: newAppKey('test'), jwtSecret: 'x'.repeat(32) } }, demoHeaders: false } })
    const anon = await secured.call(`/v1/snapshots/${big.id}`, { 'x-morphkit-app': 'crm' }, { method: 'PUT', body: JSON.stringify(big) })
    expect(anon.status).toBe(401)
  })

  it('migrates a pre-4b database (id as the only primary key) and keeps its rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-4b-'))
    const file = path.join(dir, 'old.db')
    const raw = new Database(file)
    raw.exec(`CREATE TABLE snapshots (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, user_id TEXT NOT NULL, parent_id TEXT, files TEXT NOT NULL,
      message TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, base_hash TEXT, request_id TEXT)`)
    raw.prepare('INSERT INTO snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('S1', 'crm', 'alice', null, '{}', 'base', 'base', 'now', 'applied', null, null)
    raw.close()
    const { close } = openStore({ file })
    close()
    const after = new Database(file)
    const pk = (after.prepare('PRAGMA table_info(snapshots)').all() as { name: string; pk: number }[]).filter((c) => c.pk > 0).map((c) => c.name).sort()
    expect(pk).toEqual(['app_id', 'id'])
    expect(after.prepare('SELECT id, org_id FROM snapshots').all()).toEqual([{ id: 'S1', org_id: 'default' }])
    expect(() => after.prepare("UPDATE snapshots SET files = 'x' WHERE id = 'S1'").run()).toThrow(/insert-only/)
    after.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('code review 06 §2 test 3: two tabs move the head (compare-and-set)', () => {
  it('the second tab gets 409 head-conflict and nothing changes', async () => {
    const t = setup()
    const tab1 = t.store('alice')
    const tab2 = t.store('alice')
    const base = snap('alice', null, 'base')
    await tab1.put(base)
    await tab1.setHead('alice', base.id, null)
    const a = snap('alice', base.id, 'a')
    const b = snap('alice', base.id, 'b')
    await tab1.put(a)
    await tab2.put(b)
    await tab1.setHead('alice', a.id, base.id)
    const err = await tab2.setHead('alice', b.id, base.id).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HeadConflictError)
    expect((err as HeadConflictError).actual).toBe(a.id)
    expect((await tab2.head('alice'))?.id).toBe(a.id)
    // without expectedHeadId it stays a plain write (older clients)
    await tab2.setHead('alice', b.id)
    expect((await tab1.head('alice'))?.id).toBe(b.id)
  })
})

describe('admin request list: ordering in SQL, liveness in one join', () => {
  it('pending-review first, then pending-admin, then newest; isHead from the join', async () => {
    const t = setup()
    const agent = { 'x-morphkit-agent': '1', 'x-morphkit-user': 'alice', 'x-morphkit-app': 'crm' }
    const ids: string[] = []
    for (const status of ['applied', 'pending-admin', 'failed', 'pending-review', 'applied']) {
      const r = await t.call('/v1/requests', agent, { method: 'POST', body: JSON.stringify({ userId: 'alice', text: status, status, log: [] }) })
      ids.push(((await r.json()) as { id: string }).id)
      await new Promise((res) => setTimeout(res, 2))
    }
    const list = (await (await t.call('/v1/admin/requests?limit=3', { 'x-morphkit-admin': '1', 'x-morphkit-app': 'crm' })).json()) as { id: string; status: string; isHead: boolean }[]
    expect(list.map((r) => r.status)).toEqual(['pending-review', 'pending-admin', 'applied'])
    expect(list[2]!.id).toBe(ids[4])
    expect(list.every((r) => r.isHead === false)).toBe(true)
  })
})
