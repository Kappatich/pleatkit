import { expect, test, type APIRequestContext } from '@playwright/test'
import { appFor } from './helpers'

// DECISIONS 75 (brainstorm 16, Р2 and Р4): the /admin Plan screen shows the money of the last 7 days from the pilot
// report (token cost, developer hours saved, cost per applied edit, per organization) and the expected cost of an
// edit on this app from the agent server.

test.use({ reducedMotion: 'reduce' })

/** One edit of Sonnet 5.5 as the 5f live runs metered it: $0.0333416. */
const SONNET_EDIT = { model: 'claude-sonnet-5-5', input: 4, output: 488, cacheRead: 13_018, cacheWrite: 10_340, thinking: 0 }
/** One classifier call of Haiku 5.5: $0.00006785. */
const HAIKU_CLASSIFY = { model: 'claude-haiku-5-5', input: 31, output: 76, cacheRead: 2_675, cacheWrite: 0, thinking: 0 }

async function logged(request: APIRequestContext, app: string, user: string, org: string, verdict: string, usage: Record<string, unknown>, applied: boolean): Promise<void> {
  const as = { 'x-pleatkit-user': user, 'x-pleatkit-app': app, 'x-pleatkit-org': org }
  const res = await request.post('/pleatkit-store/v1/requests', { headers: { ...as, 'x-pleatkit-agent': '1' }, data: { userId: user, text: `edit by ${user}`, verdict, status: applied ? 'proposed' : 'pending-admin', log: [], usage: [] } })
  expect(res.status()).toBe(201)
  const { id } = (await res.json()) as { id: string }
  const tokens = ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((s, k) => s + (usage[k] as number), 0)
  const ev = await request.post('/pleatkit-store/v1/events', { headers: { ...as, 'x-pleatkit-agent': '1' }, data: { events: [{ type: 'tokens.used', value: tokens, unit: 'token', userId: user, requestId: id, dedupeKey: `tokens.used:${id}:${String(usage.model)}`, props: usage }] } })
  expect(ev.status()).toBe(201)
  if (!applied) return
  const snapshotId = `money-${id}`
  const put = await request.put(`/pleatkit-store/v1/snapshots/${snapshotId}`, { headers: as, data: { id: snapshotId, parentId: null, userId: user, files: { 'src/dynamic/customer-card.tsx': `export default () => <div>${user}</div>\n` }, message: 'edit', author: 'agent', createdAt: new Date().toISOString(), status: 'applied' } })
  expect(put.ok()).toBe(true)
  const link = await request.post(`/pleatkit-store/v1/requests/${id}/link`, { headers: as, data: { snapshotId, status: 'applied' } })
  expect(link.ok()).toBe(true)
}

test('DECISIONS 75: the Plan screen shows token cost, hours saved, cost per applied edit and the expected cost per edit', async ({ page }) => {
  const app = appFor(page)
  // acme: two applied edits; globex: a request the panels could not serve (classifier only), nothing applied
  await logged(page.request, app, 'alice', 'acme', 'ok', SONNET_EDIT, true)
  await logged(page.request, app, 'dora', 'acme', 'ok', SONNET_EDIT, true)
  await logged(page.request, app, 'bob', 'globex', 'needs-backend', HAIKU_CLASSIFY, false)

  await page.goto(`/admin?view=plan&app=${app}`)
  await expect(page.getByTestId('admin-plan-money')).toBeVisible()
  // 2 × $0.0333416 + $0.00006785
  await expect(page.getByTestId('admin-plan-token-cost-value')).toHaveText('$0.0668')
  // 2 applied edits × 20 minutes
  await expect(page.getByTestId('admin-plan-hours-saved-value')).toHaveText('0.7 h')
  await expect(page.getByTestId('admin-plan-hours-saved')).toContainText('2 applied edits × 20 min')
  await expect(page.getByTestId('admin-plan-cost-per-edit-value')).toHaveText('$0.0334')
  // the demo's agent is scripted: estimated from the manifest and priced as the default models
  const expected = page.getByTestId('admin-plan-expected')
  await expect(expected).toHaveAttribute('data-source', 'estimated')
  await expect(page.getByTestId('admin-plan-expected-value')).toHaveText(/^\$0\.0\d{3}$/)
  await expect(expected).toContainText('claude-sonnet-5-5, prompt size estimated; cold (first edit after 5 min idle): $0.0')

  const orgs = page.getByTestId('admin-plan-org')
  await expect(orgs).toHaveCount(2)
  await expect(orgs.filter({ hasText: 'acme' }).getByTestId('admin-plan-org-per-edit')).toHaveText('$0.0333')
  // nothing applied in globex: no cost per applied edit
  await expect(page.locator('[data-testid="admin-plan-org"][data-org="globex"] [data-testid="admin-plan-org-per-edit"]')).toHaveText('—')
})
