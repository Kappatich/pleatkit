import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { exportData } from '../src/export.js'

describe('morphkit export (F9)', () => {
  it('asks store-server for the app or one user, with the app key, and writes one JSON file', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'morphkit-export-'))
    const doc = { format: 1, appId: 'crm', userId: 'alice', snapshots: [{ id: 's1' }, { id: 's2' }], heads: [{}], requests: [{}], events: [{}, {}, {}] }
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(doc), { headers: { 'content-type': 'application/json' } }))
    const r = await exportData({ store: 'http://store.test/', app: 'crm', user: 'alice', key: 'mk_live_x', fetch: fetchFn as unknown as typeof fetch, cwd, out: 'alice.json' })
    expect(r.ok).toBe(true)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://store.test/v1/admin/export?userId=alice')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer mk_live_x')
    expect(JSON.parse(fs.readFileSync(path.join(cwd, 'alice.json'), 'utf8'))).toEqual(doc)
    expect(r.lines[0]).toBe('exported user alice of app crm: 2 snapshots, 1 heads, 1 requests, 3 events')
  })

  it('reports a refused or unreachable store', async () => {
    const denied = vi.fn(async () => new Response('{"error":"authentication required"}', { status: 401 }))
    const r = await exportData({ store: 'http://store.test', app: 'crm', fetch: denied as unknown as typeof fetch })
    expect(r.ok).toBe(false)
    expect(r.lines.join('\n')).toMatch(/401[\s\S]*MORPHKIT_APP_KEY/)
    const down = vi.fn(async () => Promise.reject(new Error('ECONNREFUSED')))
    expect((await exportData({ store: 'http://store.test', app: 'crm', fetch: down as unknown as typeof fetch })).lines[0]).toMatch(/could not reach/)
  })
})
