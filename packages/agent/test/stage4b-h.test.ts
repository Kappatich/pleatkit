import { describe, expect, it } from 'vitest'
import { createStoreApp, openStore } from '../../store-server/src/app.js'
import type { PleatkitManifest, Snapshot } from '@pleatkit/runtime/compiler'
import { Alerts, type Alert } from '../src/alerts.js'
import { checkSnapshots } from '../src/check-snapshots.js'
import { createAgentApp } from '../src/server.js'
import { createTypechecker } from '../src/typecheck.js'
import { Workspace } from '../src/workspace.js'
import { BASE_CARD, CARD, GOOD_CARD, TABLE, request, scripted } from './helpers.js'

const API = `export interface Customer { id: string; name: string; meta: Record<string, unknown> }
export const api = { listCustomers(): Promise<Customer[]> { return Promise.resolve([]) }, rename(id: string, name: string): Promise<void> { return Promise.resolve() } }
`

describe('brainstorm 05 #4: type check against the app contracts', () => {
  const typecheck = createTypechecker()
  const ws = (card: string) => new Workspace({ ...request('x', { readonly: { 'src/readonly/api.ts': API } }), files: { ...request('x').files, [CARD]: card } }, typecheck)

  it('passes a correct edit', async () => {
    expect((await ws(GOOD_CARD).check()).errors).toEqual([])
  })

  it('refuses a call that compiles but does not exist or has the wrong types', async () => {
    const bad = `import { api, type Customer } from '@/readonly/api'
export default function CustomerCard({ customer }: { customer: Customer }) {
  void api.deleteEverything()
  void api.rename(customer.id, 42)
  return <div data-testid="customer-card">{customer.nam}</div>
}
`
    const r = await ws(bad).check()
    expect(r.ok).toBe(false)
    const text = r.errors.map((e) => e.text).join('\n')
    expect(text).toMatch(/deleteEverything/)
    expect(text).toMatch(/number.*string|string.*number/)
    expect(text).toMatch(/nam/)
    expect(r.errors.every((e) => e.rule === 'typecheck' && e.file === CARD)).toBe(true)
  })

  it('with the app root, React types resolve fully: key on a component is fine, a wrong prop is not (eval harness find)', async () => {
    const path = await import('node:path')
    const root = path.resolve(import.meta.dirname, '../../../apps/demo-crm')
    const withRoot = createTypechecker({ root })
    const ui = `import type { HTMLAttributes } from 'react'
export function Card(props: HTMLAttributes<HTMLDivElement>) { return <div {...props} /> }
`
    // without the fix, the JSX namespace of react/jsx-runtime was lost: every element `any`, `key` an error
    const list = (attr: string) => `import { Card } from '@/readonly/ui'
export default function CustomerCard({ customer }: { customer: { id: string; name: string } }) {
  return <div data-testid="customer-card">{[customer].map((c) => <Card key={c.id} ${attr}>{c.name}</Card>)}</div>
}
`
    const input = { ...request('x'), readonly: { 'src/readonly/ui.tsx': ui } }
    expect(await withRoot({ ...input.files, [CARD]: list('') }, input)).toEqual([])
    const bad = await withRoot({ ...input.files, [CARD]: list('tone="loud"') }, input)
    expect(bad.map((e) => e.text).join(' ')).toMatch(/tone/)
  })
})

describe('brainstorm 05 #5: alerts and freezing one user', () => {
  const who = { appId: 'crm', userId: 'mallory', orgId: 'default', environment: null, via: 'demo' as const }
  const collect = () => {
    const got: Alert[] = []
    return { got, sink: { send: async (a: Alert) => void got.push(a) } }
  }

  it('alerts on a static-rule violation and freezes after three within an hour', async () => {
    const { got, sink } = collect()
    const alerts = new Alerts({ sinks: [sink], log: () => undefined })
    const log = [{ turn: 1, tool: 'check', input: {}, ok: true, result: 'FAILED', ms: 1, violation: 'static check: no-remote-request' }]
    for (let i = 0; i < 3; i++) await alerts.afterRun(who, { log, verdict: 'failed', requestId: `r${i}` }, null)
    expect(got.filter((a) => a.kind === 'static-rule')).toHaveLength(3)
    expect(got.filter((a) => a.kind === 'freeze')).toHaveLength(1)
    expect(alerts.isFrozen(who)).toBe(true)
    expect(await alerts.beforeRun(who)).toBe(true)
  })

  it('budget alerts at 50, 80 and 100 % once a day each; a user eating the app budget is frozen', async () => {
    const { got, sink } = collect()
    const alerts = new Alerts({ sinks: [sink], log: () => undefined })
    for (const used of [0.3, 0.55, 0.6, 0.85, 1.02, 1.1]) await alerts.afterRun({ ...who, userId: 'bob' }, { log: [], verdict: 'ok' }, { appUsd: used, userShareOfApp: 0.1 })
    expect(got.filter((a) => a.kind === 'budget').map((a) => a.severity)).toEqual(['info', 'warning', 'critical'])
    await alerts.afterRun(who, { log: [], verdict: 'ok' }, { appUsd: 0.4, userShareOfApp: 0.35 })
    expect(alerts.isFrozen(who)).toBe(true)
  })

  it('a burst of requests freezes the user in store-server; the next run is refused', async () => {
    const { db } = openStore()
    const store = createStoreApp(db)
    const fetchVia = ((input: string | URL | Request, init?: RequestInit) => store.request(String(input), init)) as typeof fetch
    const { got, sink } = collect()
    const provider = scripted({ name: 'phone', turns: [{ calls: [{ tool: 'finish', input: { verdict: 'failed', summary: 'x' } }] }] })
    const app = createAgentApp({ provider, log: () => undefined, storeUrl: 'http://store.test', fetch: fetchVia, alerts: { sinks: [sink], freeze: { requestsPerMinute: 2 } } })
    const run = async () => {
      const text = await (await app.request('/agent/v1/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request('phone', { appId: 'crm', userId: 'mallory' })) })).text()
      return JSON.parse(/event: result\ndata: (.*)/.exec(text)![1]!) as { verdict: string; refusal?: string }
    }
    expect((await run()).verdict).toBe('failed')
    expect((await run()).verdict).toBe('failed')
    expect(await run()).toMatchObject({ verdict: 'refused', refusal: 'disabled' })
    expect(got.some((a) => a.kind === 'freeze')).toBe(true)
    const flags = (await (await store.request('/v1/flags?userId=mallory', { headers: { 'x-pleatkit-app': 'crm', 'x-pleatkit-agent': '1' } })).json()) as { flags: Record<string, unknown> }
    expect(flags.flags['edits.enabled']).toBe(false)
  })
})

describe('brainstorm 05 #4: pleatkit check-snapshots before a release', () => {
  it('reports the users whose version would not compile on the new build', async () => {
    const { db } = openStore()
    const store = createStoreApp(db)
    const fetchVia = ((input: string | URL | Request, init?: RequestInit) => store.request(String(input), init)) as typeof fetch
    const put = async (s: Snapshot, head: boolean) => {
      const h = { 'content-type': 'application/json', 'x-pleatkit-app': 'crm', 'x-pleatkit-user': s.userId }
      await store.request(`/v1/snapshots/${s.id}`, { method: 'PUT', headers: h, body: JSON.stringify(s) })
      if (head) await store.request(`/v1/snapshots/${s.id}/head`, { method: 'POST', headers: h, body: '{}' })
    }
    const files = request('x').files
    const snap = (id: string, userId: string, parentId: string | null, f: Record<string, string>): Snapshot => ({ id, userId, parentId, files: f, message: id, author: parentId ? 'agent' : 'base', createdAt: '', status: 'applied' })
    await put(snap('01A', 'alice', null, files), false)
    // alice uses meta.phone: fine on the new release
    await put(snap('01B', 'alice', '01A', { ...files, [CARD]: GOOD_CARD }), true)
    await put(snap('01C', 'bob', null, files), false)
    // bob's edit reads a field the new release's API no longer has
    await put(snap('01D', 'bob', '01C', { ...files, [CARD]: BASE_CARD.replace('{customer.name}', '{customer.name}{customer.score}') }), true)
    const manifest: PleatkitManifest = {
      version: 1,
      dynamicRoots: ['src/dynamic/'],
      dynamic: [
        { path: CARD, source: BASE_CARD },
        { path: TABLE, source: files[TABLE]! },
      ],
      readonly: [{ path: 'src/readonly/api.ts', source: 'export interface Customer { id: string; name: string; meta: Record<string, unknown> }\n' }],
      coreTypes: [],
      externals: ['react', 'react/jsx-runtime', '@/lib/utils', '@/readonly/api'],
      externalPatterns: ['react', 'react/jsx-runtime', '@/lib/utils', '@/readonly/*'],
      alias: { '@': 'src' },
    }
    const r = await checkSnapshots({ storeUrl: 'http://store.test', appId: 'crm', manifest, fetch: fetchVia, typecheck: createTypechecker() })
    expect(r.checked).toBe(2)
    expect(r.failed).toBe(1)
    const bob = r.results.find((x) => x.userId === 'bob')!
    expect(bob.ok).toBe(false)
    expect(bob.userFiles).toEqual([CARD])
    expect(r.results.find((x) => x.userId === 'alice')!.ok).toBe(true)
  })
})
