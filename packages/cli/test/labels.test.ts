import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { labelsExport, toProbes } from '../src/labels.js'

const item = (requestId: string, label: string, labeledBy = 'minte', extra: Record<string, unknown> = {}) => ({
  requestId,
  request: `request ${requestId}`,
  label,
  suggested: 'ui',
  labeledBy,
  labeledAt: '2026-10-19T10:00:00.000Z',
  ...extra,
})

describe('pleatkit labels export (DECISIONS 81)', () => {
  it('asks the store for the disagreements and writes them as eval:classify probes', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pleatkit-labels-'))
    const items = [item('req_1', 'needs-backend'), item('req_2', 'mixed')]
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ appId: 'demo-crm', filter: 'disagreements', items }), { headers: { 'content-type': 'application/json' } }))
    const r = await labelsExport({ store: 'http://store.test/v1', app: 'demo-crm', key: 'mk_live_x', fetch: fetchFn as unknown as typeof fetch, cwd, now: new Date('2026-10-19T12:00:00Z') })
    expect(r.ok).toBe(true)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://store.test/v1/admin/labels/export?filter=disagreements')
    expect(init.headers).toMatchObject({ authorization: 'Bearer mk_live_x', 'x-pleatkit-app': 'demo-crm' })
    const file = path.join(cwd, 'evals', 'probes', 'human-disagreements.json')
    expect(r.file).toBe(file)
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { description: string; probes: unknown[] }
    expect(doc.description).toMatch(/disagreed with the classifier/)
    expect(doc.probes).toEqual([
      { id: 'human-req_1', app: 'demo-crm', request: 'request req_1', expected: 'needs-backend', suggested: 'ui', labeledBy: 'minte', labeledAt: '2026-10-19T10:00:00.000Z' },
      { id: 'human-req_2', app: 'demo-crm', request: 'request req_2', expected: 'mixed', suggested: 'ui', labeledBy: 'minte', labeledAt: '2026-10-19T10:00:00.000Z' },
    ])
    expect(r.lines.at(-1)).toBe('run: pnpm eval:classify -- --probes evals/probes/human-disagreements.json')
  })

  it('--all asks for every label, --eval-app names the eval app, --out the file; the development header without a key', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pleatkit-labels-'))
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ items: [item('req_1', 'ui')] })))
    const r = await labelsExport({ store: 'http://store.test', app: 'acme-prod', evalApp: 'shadcn-admin', all: true, out: 'out.json', fetch: fetchFn as unknown as typeof fetch, cwd })
    expect(r.ok).toBe(true)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://store.test/v1/admin/labels/export?filter=all')
    expect(init.headers).toMatchObject({ 'x-pleatkit-admin': '1', 'x-pleatkit-app': 'acme-prod' })
    expect((JSON.parse(fs.readFileSync(path.join(cwd, 'out.json'), 'utf8')) as { probes: { app: string }[] }).probes[0]!.app).toBe('shadcn-admin')
  })

  it('refuses an app that is not an eval app, and reports a refused or unreachable store; writes nothing when empty', async () => {
    const never = vi.fn()
    const r = await labelsExport({ store: 'http://store.test', app: 'acme-prod', fetch: never as unknown as typeof fetch })
    expect(r.ok).toBe(false)
    expect(r.lines[0]).toMatch(/not an eval app.*--eval-app/)
    expect((await labelsExport({ store: 'http://store.test', app: 'demo-crm', evalApp: 'nope', fetch: never as unknown as typeof fetch })).lines[0]).toMatch(/--eval-app "nope"/)
    expect(never).not.toHaveBeenCalled()
    const denied = vi.fn(async () => new Response('{"error":"admin only"}', { status: 401 }))
    expect((await labelsExport({ store: 'http://store.test', app: 'demo-crm', fetch: denied as unknown as typeof fetch })).lines.join('\n')).toMatch(/401[\s\S]*PLEATKIT_APP_KEY/)
    const down = vi.fn(async () => Promise.reject(new Error('ECONNREFUSED')))
    expect((await labelsExport({ store: 'http://store.test', app: 'demo-crm', fetch: down as unknown as typeof fetch })).lines[0]).toMatch(/could not reach/)
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pleatkit-labels-'))
    const empty = vi.fn(async () => new Response(JSON.stringify({ items: [] })))
    const e = await labelsExport({ store: 'http://store.test', app: 'demo-crm', fetch: empty as unknown as typeof fetch, cwd })
    expect(e).toMatchObject({ ok: true, lines: ['no disagreements with the classifier in app demo-crm yet: nothing written'] })
    expect(fs.existsSync(path.join(cwd, 'evals'))).toBe(false)
  })

  it('names a probe by its request, plus the labeller when two people labelled it; drops unknown labels', () => {
    const probes = toProbes([item('req_1', 'ui', 'minte'), item('req_1', 'clarify', 'arch itect'), item('req_2', 'restore'), item('req_3', 'declined')], 'tailadmin')
    expect(probes.map((p) => p.id)).toEqual(['human-req_1-minte', 'human-req_1-arch_itect', 'human-req_3'])
  })
})
