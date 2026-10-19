import { describe, expect, it } from 'vitest'
import { HttpStore, type Snapshot } from '@pleatkit/runtime'
import { createStoreApp, openStore } from '../src/index.js'
import { csvField, REPORT_COLUMNS } from '../src/report.js'

function setup(options: Parameters<typeof createStoreApp>[1] = {}) {
  const store = openStore()
  const app = createStoreApp(store.db, options)
  const call = (path: string, headers: Record<string, string>, init: RequestInit = {}) =>
    app.request(`http://store.test${path}`, { ...init, headers: { 'content-type': 'application/json', ...headers } })
  const fetchVia = ((input: string | URL | Request, init?: RequestInit) => app.request(input instanceof Request ? input : String(input), init)) as typeof fetch
  const agent = (userId: string, orgId: string) => ({ 'x-pleatkit-agent': '1', 'x-pleatkit-user': userId, 'x-pleatkit-app': 'crm', 'x-pleatkit-org': orgId })
  const admin = { 'x-pleatkit-admin': '1', 'x-pleatkit-app': 'crm' }
  return { call, fetchVia, agent, admin }
}

let seq = 0
const snap = (userId: string, parentId: string | null, files: Record<string, string>, extra: Partial<Snapshot> = {}): Snapshot => ({
  id: `01M${String(++seq).padStart(6, '0')}`,
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

type T = ReturnType<typeof setup>

/** A logged request; with `apply`, the edit becomes the user's head (an applied edit). */
async function request(t: T, userId: string, orgId: string, verdict: string, apply: boolean): Promise<void> {
  const res = await t.call('/v1/requests', t.agent(userId, orgId), { method: 'POST', body: JSON.stringify({ userId, text: `edit by ${userId}`, verdict, status: apply ? 'proposed' : 'pending-admin', log: [], usage: [] }) })
  const { id: requestId } = (await res.json()) as { id: string }
  if (!apply) return
  const s = new HttpStore({ baseUrl: 'http://store.test', userId, appId: 'crm', fetch: t.fetchVia, headers: { 'x-pleatkit-org': orgId } })
  const base = snap(userId, null, { [CARD]: 'export default () => <div>card</div>\n' })
  await s.put(base)
  const v1 = snap(userId, base.id, { [CARD]: `export default () => <div>${userId}</div>\n` }, { requestId })
  await s.put(v1)
  await s.setHead(userId, v1.id)
  await s.linkRequest(requestId, { snapshotId: v1.id, status: 'applied' })
}

/** One `tokens.used` event as the agent server records it (`usageEvents`). */
async function tokens(t: T, userId: string, orgId: string, key: string, model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number }): Promise<void> {
  const value = u.input + u.output + u.cacheRead + u.cacheWrite
  const res = await t.call('/v1/events', t.agent(userId, orgId), { method: 'POST', body: JSON.stringify({ events: [{ type: 'tokens.used', value, unit: 'token', userId, dedupeKey: `tokens.used:${key}:${model}`, props: { model, ...u, thinking: 0 } }] }) })
  expect(res.status).toBe(201)
}

const SONNET_EDIT = { input: 4, output: 488, cacheRead: 13_018, cacheWrite: 10_340 } // $0.0333416
const HAIKU_CLASSIFY = { input: 31, output: 76, cacheRead: 2_675, cacheWrite: 0 } // $0.00006785

/** acme: two applied edits; globex: one applied edit on an unpriced model; initech: a request that applied nothing. */
async function pilotWeek(t: T): Promise<void> {
  await request(t, 'alice', 'acme', 'ok', true)
  await tokens(t, 'alice', 'acme', 'r1', 'claude-sonnet-5-5', SONNET_EDIT)
  await tokens(t, 'alice', 'acme', 'r1', 'claude-haiku-5-5', HAIKU_CLASSIFY)
  await request(t, 'dora', 'acme', 'ok', true)
  await tokens(t, 'dora', 'acme', 'r2', 'claude-sonnet-5-5', SONNET_EDIT)
  await request(t, 'bob', 'globex', 'ok', true)
  await tokens(t, 'bob', 'globex', 'r3', 'gpt-x', { input: 900, output: 100, cacheRead: 0, cacheWrite: 0 })
  await request(t, 'carol', 'initech', 'needs-backend', false)
  await tokens(t, 'carol', 'initech', 'r4', 'claude-haiku-5-5', HAIKU_CLASSIFY)
}

describe('DECISIONS 75 Р4: money in the pilot report', () => {
  const today = new Date().toISOString().slice(0, 10)

  it('token cost from the ledger, developer hours saved and cost per applied edit, per day × org, per org and in total', async () => {
    const t = setup()
    await pilotWeek(t)
    const res = await t.call(`/v1/report?from=${today}&to=${today}`, t.admin)
    expect(res.status).toBe(200)
    const lines = (await res.text()).trim().split('\r\n')
    // the old columns keep their places; the money columns come after them
    expect(lines[0]).toBe(REPORT_COLUMNS.join(','))
    expect(REPORT_COLUMNS.slice(-5)).toEqual(['cost_usd', 'token_cost_usd', 'unpriced_tokens', 'dev_hours_saved', 'cost_per_applied_edit_usd'])
    const rows = lines.slice(1).map((l) => Object.fromEntries(l.split(',').map((v, i) => [REPORT_COLUMNS[i], v])))
    const acmeEdit = 2 * 0.0333416 + 0.00006785
    // day × org rows first, then one row per org over the range, then the total
    expect(rows.map((r) => `${r.date}/${r.org}`)).toEqual([`${today}/acme`, `${today}/globex`, `${today}/initech`, 'all/acme', 'all/globex', 'all/initech', 'total/all'])
    const acme = rows.find((r) => r.date === 'all' && r.org === 'acme')!
    expect(acme).toMatchObject({ users: '2', applied: '2', token_cost_usd: String(Number(acmeEdit.toFixed(4))), unpriced_tokens: '0', dev_hours_saved: '0.7', cost_per_applied_edit_usd: String(Number((acmeEdit / 2).toFixed(4))) })
    const globex = rows.find((r) => r.date === 'all' && r.org === 'globex')!
    expect(globex).toMatchObject({ applied: '1', token_cost_usd: '0', unpriced_tokens: '1000', dev_hours_saved: '0.3', cost_per_applied_edit_usd: '0' })
    // nothing applied: no cost per applied edit (empty, not zero)
    const initech = rows.find((r) => r.date === 'all' && r.org === 'initech')!
    expect(initech).toMatchObject({ applied: '0', needs_backend: '1', token_cost_usd: '0.0001', dev_hours_saved: '0', cost_per_applied_edit_usd: '' })
    expect(rows.at(-1)).toMatchObject({ orgs: '3', users: '4', applied: '3', unpriced_tokens: '1000', dev_hours_saved: '1', token_cost_usd: String(Number((acmeEdit + 0.00006785).toFixed(4))), cost_per_applied_edit_usd: String(Number(((acmeEdit + 0.00006785) / 3).toFixed(4))) })

    const json = (await (await t.call(`/v1/report?from=${today}&to=${today}&format=json`, t.admin)).json()) as {
      minutesPerEdit: number
      unpricedModels: string[]
      rows: unknown[]
      orgs: Record<string, unknown>[]
      total: Record<string, unknown>
    }
    expect(json).toMatchObject({ minutesPerEdit: 20, unpricedModels: ['gpt-x'] })
    expect(json.rows).toHaveLength(3)
    expect(json.orgs.map((o) => o.org)).toEqual(['acme', 'globex', 'initech'])
    expect(json.orgs.find((o) => o.org === 'initech')!.cost_per_applied_edit_usd).toBeNull()
    expect(json.total.dev_hours_saved).toBe(1)
  })

  it('minutes per edit: the query parameter wins over PLEATKIT_REPORT_MINUTES_PER_EDIT, which wins over 20', async () => {
    const t = setup({ reportMinutesPerEdit: 30 })
    await pilotWeek(t)
    const total = async (q = '') => ((await (await t.call(`/v1/report?from=${today}&to=${today}&format=json${q}`, t.admin)).json()) as { minutesPerEdit: number; total: Record<string, unknown> })
    expect(await total()).toMatchObject({ minutesPerEdit: 30, total: { dev_hours_saved: 1.5 } })
    expect(await total('&minutesPerEdit=45')).toMatchObject({ minutesPerEdit: 45, total: { dev_hours_saved: 2.3 } })
    for (const bad of ['0', '-5', 'abc', '481', '']) expect((await t.call(`/v1/report?from=${today}&to=${today}&minutesPerEdit=${bad}`, t.admin)).status).toBe(400)
    // still admin-only
    expect((await t.call(`/v1/report?from=${today}&to=${today}`, { 'x-pleatkit-user': 'alice', 'x-pleatkit-app': 'crm' })).status).toBe(403)
  })

  it('tokens outside the range are not counted; an empty range has an empty cost per applied edit', async () => {
    const t = setup()
    await pilotWeek(t)
    const json = (await (await t.call('/v1/report?from=2001-01-01&to=2001-01-02&format=json', t.admin)).json()) as { rows: unknown[]; orgs: unknown[]; total: Record<string, unknown> }
    expect(json.rows).toEqual([])
    expect(json.orgs).toEqual([])
    expect(json.total).toMatchObject({ requests: 0, token_cost_usd: 0, unpriced_tokens: 0, dev_hours_saved: 0, cost_per_applied_edit_usd: null })
    expect(csvField(null)).toBe('')
  })
})
