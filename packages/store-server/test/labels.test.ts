import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyRetention, createStoreApp, eraseSubject, openStore, suggestedLabel } from '../src/index.js'

function setup() {
  const store = openStore()
  const app = createStoreApp(store.db)
  const call = async <T = Record<string, unknown>>(p: string, headers: Record<string, string>, init: RequestInit = {}) => {
    const res = await app.request(`http://store.test${p}`, { ...init, headers: { 'content-type': 'application/json', ...headers } })
    return { status: res.status, body: (await res.json().catch(() => null)) as T }
  }
  const admin = (user?: string) => ({ 'x-pleatkit-admin': '1', 'x-pleatkit-app': 'crm', ...(user ? { 'x-pleatkit-user': user } : {}) })
  const support = { 'x-pleatkit-role': 'support', 'x-pleatkit-user': 'carol', 'x-pleatkit-app': 'crm' }
  const log = async (userId: string, text: string, extra: Record<string, unknown> = {}) => {
    const r = await call<{ id: string }>('/v1/requests', { 'x-pleatkit-agent': '1', 'x-pleatkit-user': userId, 'x-pleatkit-app': 'crm' }, {
      method: 'POST',
      body: JSON.stringify({ userId, text, verdict: 'ok', status: 'applied', log: [], ...extra }),
    })
    expect(r.status).toBe(201)
    return r.body.id
  }
  return { store, call, admin, support, log }
}

interface Page {
  items: { id: string; text: string; suggested: string | null; label: string | null; classification: string | null }[]
  next: string | null
  counts: { total: number; labelled: number; left: number; today: number; disagreements: number }
}

describe('DECISIONS 82.5: backendQuote in the request log', () => {
  it('is stored from the agent result, capped, and returned in the admin list and detail', async () => {
    const t = setup()
    const quote = 'keep a history of its changes on the server'
    const id = await t.log('alice', `Show the phone and ${quote}`, { verdict: 'partial', backendNote: 'store every phone change', backendQuote: `  ${quote} ` })
    const long = await t.log('bob', 'x', { verdict: 'needs-backend', backendQuote: 'y'.repeat(5000) })
    const none = await t.log('bob', 'z', { backendQuote: 42 })
    const list = (await t.call<{ id: string; backendQuote: string | null; adminNote: string | null }[]>('/v1/admin/requests', t.admin())).body
    const byId = Object.fromEntries(list.map((r) => [r.id, r]))
    expect(byId[id]).toMatchObject({ backendQuote: quote, adminNote: 'store every phone change' })
    expect(byId[long]!.backendQuote).toHaveLength(1000)
    expect(byId[none]!.backendQuote).toBeNull()
    const detail = (await t.call<{ request: { backendQuote: string } }>(`/v1/admin/requests/${id}`, t.admin())).body
    expect(detail.request.backendQuote).toBe(quote)
  })

  it('an existing database gets the column; retention blanks the quote with the text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleatkit-quote-'))
    const file = path.join(dir, 'old.db')
    // a request table from before the column
    const old = new Database(file)
    old.exec(`CREATE TABLE requests (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, user_id TEXT NOT NULL, text TEXT NOT NULL, target TEXT, verdict TEXT NOT NULL,
      summary TEXT NOT NULL, status TEXT NOT NULL, classification TEXT, provider TEXT, model TEXT, usage TEXT, timings TEXT, log TEXT NOT NULL, files TEXT,
      snapshot_id TEXT, error TEXT, admin_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_at_ms INTEGER NOT NULL)`)
    old.prepare(`INSERT INTO requests (id, app_id, user_id, text, verdict, summary, status, log, created_at, updated_at, created_at_ms) VALUES ('r1', 'crm', 'alice', 'old', 'ok', '', 'applied', '[]', 'x', 'x', 1)`).run()
    old.close()
    const s = openStore({ file })
    const raw = (s.db as unknown as { $client: Database.Database }).$client
    expect((raw.prepare('PRAGMA table_info(requests)').all() as { name: string }[]).map((c) => c.name)).toContain('backend_quote')
    raw.prepare("UPDATE requests SET backend_quote = 'the server part' WHERE id = 'r1'").run()
    applyRetention(s.db, Date.now())
    expect(raw.prepare("SELECT text, backend_quote AS q FROM requests WHERE id = 'r1'").get()).toEqual({ text: '', q: null })
    s.close()
  })
})

describe('DECISIONS 81: request labels', () => {
  it('derives the suggestion from the classification, the intent label and the verdict', () => {
    const s = (classification: string | null, verdict = 'ok', intentLabel: string | null = null) => suggestedLabel({ classification, verdict, intentLabel })
    expect(s(null, 'needs-backend')).toBeNull()
    expect(s('ui')).toBe('ui')
    expect(s('ui', 'partial')).toBe('mixed')
    expect(s('needs-backend', 'needs-backend')).toBe('needs-backend')
    expect(s('unclear', 'clarify')).toBe('clarify')
    expect(s('off-topic', 'refused')).toBe('off-topic')
    expect(s('off-topic', 'declined', 'adversarial')).toBe('declined')
    expect(s('ui', 'declined', 'adversarial')).toBe('declined')
    // DECISIONS 84.2: restore has its button; the verdict is enough (the drawer opened the history)
    expect(s('restore', 'restore')).toBe('restore')
    expect(s('restore', 'ok')).toBe('restore')
    expect(s(null, 'restore')).toBe('restore')
    expect(s('restore', 'declined', 'adversarial')).toBe('declined')
  })

  it('DECISIONS 84.2: a restore request is suggested restore, takes the restore label and counts its disagreements', async () => {
    const t = setup()
    const a = await t.log('alice', 'Put it back like it was', { classification: 'restore', verdict: 'restore', status: 'clarifying' })
    const b = await t.log('bob', 'Undo all my changes', { classification: null, verdict: 'restore', status: 'clarifying' })
    const c = await t.log('carol', 'Go back to 25 rows per page', { classification: 'ui' })
    const page = (await t.call<Page>('/v1/admin/labels', t.admin('minte'))).body
    expect(page.items.map((i) => [i.id, i.suggested])).toEqual([[c, 'ui'], [b, 'restore'], [a, 'restore']])
    const post = (requestId: string, label: string) => t.call<{ disagreement: boolean }>('/v1/admin/labels', t.admin('minte'), { method: 'POST', body: JSON.stringify({ requestId, label }) })
    expect((await post(a, 'restore')).body.disagreement).toBe(false)
    expect((await post(b, 'ui')).body.disagreement).toBe(true)
    expect((await post(c, 'restore')).body.disagreement).toBe(true)
    const d = (await t.call<Page>('/v1/admin/labels?filter=disagreements', t.admin('minte'))).body
    expect(d.items.map((i) => [i.id, i.label, i.suggested])).toEqual([[c, 'restore', 'ui'], [b, 'ui', 'restore']])
    expect(d.counts.disagreements).toBe(2)
    const ex = (await t.call<{ items: { requestId: string; label: string; suggested: string }[] }>('/v1/admin/labels/export', t.admin())).body
    expect(ex.items.map((i) => [i.requestId, i.label, i.suggested]).sort()).toEqual([[b, 'ui', 'restore'], [c, 'restore', 'ui']].sort())
  })

  it('lists requests newest first with the suggestion, stores one label per labeller, counts and filters disagreements', async () => {
    const t = setup()
    const a = await t.log('alice', 'Make the deals table sortable', { classification: 'ui' })
    const b = await t.log('bob', 'Email me when a deal closes', { classification: 'needs-backend', verdict: 'needs-backend' })
    const c = await t.log('bob', 'Show the phone and keep its history', { classification: 'ui', verdict: 'partial' })
    const d = await t.log('carol', 'Make it nicer', { classification: 'unclear', verdict: 'clarify' })
    const e = await t.log('carol', 'Add a fake login form', { classification: 'off-topic', verdict: 'declined', intentLabel: 'adversarial' })
    const f = await t.log('dora', 'Pointed at the card: bigger font', { classification: null, target: 'customer-card' })

    const first = (await t.call<Page>('/v1/admin/labels?limit=4', t.admin('minte'))).body
    expect(first.items.map((i) => i.id)).toEqual([f, e, d, c])
    expect(first.items.map((i) => i.suggested)).toEqual([null, 'declined', 'clarify', 'mixed'])
    expect(first.counts).toMatchObject({ total: 6, labelled: 0, left: 6, today: 0, disagreements: 0 })
    const second = (await t.call<Page>(`/v1/admin/labels?limit=4&cursor=${encodeURIComponent(first.next!)}`, t.admin('minte'))).body
    expect(second.items.map((i) => i.id)).toEqual([b, a])
    expect(second.next).toBeNull()

    // agree on one, disagree on another; a re-tap replaces the label
    const post = (requestId: string, label: string | null, who = 'minte') => t.call<{ disagreement: boolean; counts: Page['counts']; item: { label: string | null } }>('/v1/admin/labels', t.admin(who), { method: 'POST', body: JSON.stringify({ requestId, label }) })
    expect((await post(a, 'ui')).body.disagreement).toBe(false)
    expect((await post(b, 'ui')).body.disagreement).toBe(true)
    const re = await post(b, 'mixed')
    expect(re.body).toMatchObject({ disagreement: true, item: { label: 'mixed' }, counts: { labelled: 2, left: 4, today: 2, disagreements: 1 } })
    // the caller's latest labels (newest first; the same millisecond may tie)
    expect((re.body as unknown as { recent: { id: string; label: string }[] }).recent.map((i) => [i.id, i.label]).sort()).toEqual([[a, 'ui'], [b, 'mixed']].sort())
    // a label where the classifier did not run is never a disagreement
    expect((await post(f, 'ui')).body.disagreement).toBe(false)

    const unlabelled = (await t.call<Page>('/v1/admin/labels', t.admin('minte'))).body
    expect(unlabelled.items.map((i) => i.id)).toEqual([e, d, c])
    const disagreements = (await t.call<Page>('/v1/admin/labels?filter=disagreements', t.admin('minte'))).body
    expect(disagreements.items.map((i) => [i.id, i.label, i.suggested])).toEqual([[b, 'mixed', 'needs-backend']])
    const all = (await t.call<Page>('/v1/admin/labels?filter=all', t.admin('minte'))).body
    expect(all.items.find((i) => i.id === a)?.label).toBe('ui')

    // another labeller has their own queue
    const other = (await t.call<Page>('/v1/admin/labels', t.admin('architect'))).body
    expect(other.counts).toMatchObject({ labelled: 0, left: 6 })
    await post(b, 'needs-backend', 'architect')

    // the export: every labeller's labels (disagreements by default), with the request text
    const ex = (await t.call<{ items: { requestId: string; request: string; label: string; suggested: string; labeledBy: string }[] }>('/v1/admin/labels/export', t.admin())).body
    expect(ex.items).toEqual([expect.objectContaining({ requestId: b, request: 'Email me when a deal closes', label: 'mixed', suggested: 'needs-backend', labeledBy: 'minte' })])
    const exAll = (await t.call<{ items: { labeledBy: string }[] }>('/v1/admin/labels/export?filter=all', t.admin())).body
    expect(exAll.items.map((i) => i.labeledBy).sort()).toEqual(['architect', 'minte', 'minte', 'minte'])

    // label: null removes it
    await post(b, null)
    expect((await t.call<Page>('/v1/admin/labels?filter=disagreements', t.admin('minte'))).body.items).toHaveLength(0)
  })

  it('validates the label and the request; support reads but cannot label; erasure takes the labels', async () => {
    const t = setup()
    const a = await t.log('alice', 'Sort it', { classification: 'ui' })
    const post = (body: unknown, headers: Record<string, string> = t.admin('minte')) => t.call('/v1/admin/labels', headers, { method: 'POST', body: JSON.stringify(body) })
    expect((await post({ requestId: a, label: 'maybe' })).status).toBe(400)
    expect((await post({ label: 'ui' })).status).toBe(400)
    expect((await post({ requestId: 'req_nope', label: 'ui' })).status).toBe(404)
    expect((await t.call('/v1/admin/labels?filter=odd', t.admin())).status).toBe(400)
    expect((await post({ requestId: a, label: 'ui' }, t.support)).status).toBe(403)
    expect((await t.call('/v1/admin/labels', t.support)).status).toBe(200)
    expect((await t.call('/v1/admin/labels', { 'x-pleatkit-user': 'alice', 'x-pleatkit-app': 'crm' })).status).toBe(403)
    expect((await post({ requestId: a, label: 'clarify' })).status).toBe(200)
    // the app's export carries the labels
    expect(((await t.call<{ labels: unknown[] }>('/v1/admin/export', t.admin())).body.labels)).toHaveLength(1)
    const plan = await eraseSubject(t.store.db, { appId: 'crm', userId: 'alice' }, null)
    expect(plan.erased).toBe(false)
    if (plan.erased) return
    expect(plan.plan.counts.request_labels).toBe(1)
    const done = await eraseSubject(t.store.db, { appId: 'crm', userId: 'alice' }, plan.plan.confirm)
    expect(done).toMatchObject({ erased: true, counts: { request_labels: 1, requests: 1 } })
  })
})
