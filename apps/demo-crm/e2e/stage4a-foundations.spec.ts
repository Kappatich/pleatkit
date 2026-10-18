import { expect, test, type APIRequestContext } from '@playwright/test'
import { ask, openChat, openCrm } from './chat-helpers'
import { appFor } from './helpers'

const SCENARIO_1 = 'In the customer card add phone, city and source; highlight an overdue payment date in red'
const adminHeaders = (app: string) => ({ 'x-pleatkit-admin': '1', 'x-pleatkit-app': app })
const setFlag = (request: APIRequestContext, app: string, data: Record<string, unknown>) => request.put('/pleatkit-store/v1/admin/flags', { headers: adminHeaders(app), data })

test('F6: the kill switch hides the chat and shows everyone the original; edits.enabled=false keeps versions, takes no new edits', async ({ page, request }) => {
  await openCrm(page)
  const app = appFor(page)
  const { turn } = await ask(page, SCENARIO_1)
  await expect(turn).toHaveAttribute('data-status', 'applied')
  const card = page.getByTestId('customer-card')
  await expect(card.getByTestId('phone')).toBeVisible()

  // edits off for alice only: her version stays, the chat says new changes are off, the agent refuses too
  expect((await setFlag(request, app, { scope: 'user', scopeId: 'alice', key: 'edits.enabled', value: false })).ok()).toBe(true)
  await openCrm(page)
  await expect(card.getByTestId('phone')).toBeVisible()
  await openChat(page)
  await expect(page.getByTestId('mk-chat-paused')).toContainText(/paused/)

  // the kill switch for the whole app: original version, no chat at all
  await setFlag(request, app, { scope: 'app', key: 'pleatkit.enabled', value: false })
  await openCrm(page)
  await expect(card.getByTestId('phone')).toHaveCount(0)
  await expect(page.getByTestId('mk-chat-open')).toHaveCount(0)

  // switched back on: everything returns
  await setFlag(request, app, { scope: 'app', key: 'pleatkit.enabled', value: null })
  await setFlag(request, app, { scope: 'user', scopeId: 'alice', key: 'edits.enabled', value: null })
  await openCrm(page)
  await expect(card.getByTestId('phone')).toBeVisible()
  await expect(page.getByTestId('mk-chat-open')).toBeVisible()
})

test('F3/F7/F9: usage events, a verifiable audit chain and an export, through the app proxy', async ({ page, request }) => {
  await openCrm(page)
  const app = appFor(page)
  const { turn } = await ask(page, SCENARIO_1)
  await expect(turn).toHaveAttribute('data-status', 'applied')
  await page.getByTestId('mk-chat-undo').click()
  await expect(page.getByTestId('customer-card').getByTestId('phone')).toHaveCount(0)

  await expect
    .poll(async () => [...new Set(((await (await request.get('/pleatkit-store/v1/admin/events', { headers: adminHeaders(app) })).json()) as { type: string }[]).map((e) => e.type))].sort())
    .toEqual(['cost.usd', 'edit.applied', 'edit.requested', 'edit.reverted', 'editor.active', 'tokens.used'])

  const audit = (await (await request.get('/pleatkit-store/v1/admin/audit?verify=1', { headers: adminHeaders(app) })).json()) as { verify: { ok: boolean; rows: number } }
  expect(audit.verify.ok).toBe(true)
  expect(audit.verify.rows).toBeGreaterThan(4)

  const doc = (await (await request.get('/pleatkit-store/v1/admin/export?userId=alice', { headers: adminHeaders(app) })).json()) as { snapshots: { files: Record<string, string> }[]; requests: { promptVersion: string | null }[] }
  expect(doc.snapshots.length).toBeGreaterThanOrEqual(2)
  expect(Object.keys(doc.snapshots[0]!.files).length).toBeGreaterThan(0)
  expect(doc.requests[0]?.promptVersion).toBeTruthy()
})

test('F5: a retried write with the same Idempotency-Key applies once', async ({ request }) => {
  const app = `idem-${Date.now().toString(36)}`
  const headers = { 'x-pleatkit-agent': '1', 'x-pleatkit-user': 'alice', 'x-pleatkit-app': app, 'idempotency-key': 'retry-1' }
  const data = { userId: 'alice', text: 'x', log: [] }
  const a = await request.post('/pleatkit-store/v1/requests', { headers, data })
  const b = await request.post('/pleatkit-store/v1/requests', { headers, data })
  expect(b.headers()['idempotent-replayed']).toBe('true')
  expect(await b.json()).toEqual(await a.json())
  const list = (await (await request.get('/pleatkit-store/v1/admin/requests', { headers: adminHeaders(app) })).json()) as unknown[]
  expect(list).toHaveLength(1)
})
