import { expect, test, type Page } from '@playwright/test'
import { adminUrl, ask, openCrm } from './chat-helpers'
import { appFor, shot as rawShot } from './helpers'

const SCENARIO_1 = 'In the customer card add phone, city and source; highlight an overdue payment date in red'
const admin = (app: string) => ({ 'x-pleatkit-admin': '1', 'x-pleatkit-app': app })

// screenshots of settled screens: no fade-in caught halfway, no hover left on the last button clicked
test.use({ reducedMotion: 'reduce' })
async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(1, 1)
  await rawShot(page, name)
}

test('4a screens: flags, events, audit chain, plan and usage; the cloud screens are not in the open admin', async ({ page }) => {
  await openCrm(page, { user: 'alice' })
  await expect((await ask(page, SCENARIO_1)).turn).toHaveAttribute('data-status', 'applied')
  await openCrm(page, { user: 'bob' })
  await expect((await ask(page, 'Add a discount field to deals and recalculate the amount on the server')).turn).toHaveAttribute('data-status', 'needs-backend')
  const app = appFor(page)

  // the open admin: requests, labels, flags, events, audit, plan (the pleatkit cloud adds its own screens)
  await page.goto(adminUrl(page))
  await expect(page.getByTestId('admin-nav').locator('a')).toHaveText(['Requests', 'Labels', 'Flags', 'Events', 'Audit', 'Plan'])

  // flags: freeze bob's new edits from the form
  await page.goto(`/admin?view=flags&app=${app}`)
  await page.getByTestId('admin-flag-id').fill('bob')
  await page.getByTestId('admin-flag-set').click()
  await expect(page.getByTestId('admin-flag')).toHaveCount(1)
  await expect(page.getByTestId('admin-flag')).toContainText('edits.enabled')
  await expect(page.getByTestId('admin-flags-state')).toContainText('pleatkit: on · New edits: on')
  await shot(page, '19-admin-flags.png')
  const flags = (await (await page.request.get(`/pleatkit-store/v1/flags?userId=bob`, { headers: { 'x-pleatkit-agent': '1', 'x-pleatkit-app': app } })).json()) as { flags: Record<string, unknown> }
  expect(flags.flags['edits.enabled']).toBe(false)

  await page.goto(`/admin?view=events&app=${app}`)
  await expect(page.getByTestId('admin-events-stats')).toContainText('2 requested · 1 applied')
  await page.getByTestId('admin-events-type-edit.applied').click()
  await expect(page.getByTestId('admin-event')).toHaveCount(1)
  await page.getByTestId('admin-events-type-all').click()
  await shot(page, '20-admin-events.png')

  await page.goto(`/admin?view=audit&app=${app}`)
  await expect(page.getByTestId('admin-audit-verify')).toHaveAttribute('data-ok', 'true')
  await expect(page.getByTestId('admin-audit-verify')).toContainText('Chain intact')
  await shot(page, '21-admin-audit.png')

  // stage 5 block 3: a run the model provider's rate limit stopped shows in today's row of the usage table
  const ev = await page.request.post('/pleatkit-store/v1/events', { headers: { 'content-type': 'application/json', 'x-pleatkit-agent': '1', 'x-pleatkit-user': 'alice', 'x-pleatkit-app': app }, data: { events: [{ type: 'edit.rate_limited', value: 1, unit: 'edit', userId: 'alice', dedupeKey: `edit.rate_limited:${app}` }] } })
  expect(ev.ok()).toBe(true)
  await page.goto(`/admin?view=plan&app=${app}`)
  await expect(page.getByTestId('admin-plan-today')).toContainText('Plan: free (default)')
  await expect(page.getByTestId('admin-plan-rate-limited').first()).toHaveText('1')
  await expect(page.getByTestId('admin-plan-today')).toContainText('2 of 300 edits')
  await page.getByTestId('admin-plan-appDailyEdits').fill('500')
  await page.getByTestId('admin-plan-save').click()
  await expect(page.getByTestId('admin-plan-msg')).toContainText('Saved')
  const plan = (await (await page.request.get('/pleatkit-store/v1/admin/plan', { headers: admin(app) })).json()) as { limits: Record<string, number> }
  expect(plan.limits.appDailyEdits).toBe(500)
  await shot(page, '22-admin-plan.png')
})
