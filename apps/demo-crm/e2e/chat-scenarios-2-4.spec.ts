import { expect, test } from '@playwright/test'
import { adminUrl, ask, openCrm, recordMetrics } from './chat-helpers'
import { shot } from './helpers'

test('chat scenario 2: a backend request goes to the admin, the app does not change', async ({ page }) => {
  await openCrm(page)
  const deals = page.getByTestId('deals-table')
  const before = await deals.innerHTML()
  const { turn, wallMs } = await ask(page, 'Add a discount field to deals and recalculate the amount on the server')
  await expect(turn).toHaveAttribute('data-status', 'needs-backend')
  await expect(turn.getByTestId('mk-chat-summary')).toContainText('passed the request to the administrator')
  expect(await deals.innerHTML()).toBe(before)
  await expect(page.getByTestId('mk-chat-undo')).toBeDisabled()
  await shot(page, '10-needs-backend.png')
  recordMetrics('chatScenario2', { provider: 'scripted', wallClockMs: wallMs })

  await page.goto(adminUrl(page))
  const row = page.getByTestId('admin-row').first()
  await expect(row).toHaveAttribute('data-verdict', 'needs-backend')
  await expect(row).toHaveAttribute('data-status', 'pending-admin')
  await expect(page.getByTestId('stat-backend')).toHaveText('100%')
  await row.click()
  await page.getByTestId('admin-approve').click()
  await expect(row).toHaveAttribute('data-status', 'in-progress')
})

test('chat scenario 3: the first version does not compile, the commit is rejected, the agent fixes it', async ({ page }) => {
  await openCrm(page)
  const { turn } = await ask(page, 'Make the customer name bigger and show the status as a coloured pill')
  await expect(turn).toHaveAttribute('data-status', 'applied')
  const steps = turn.getByTestId('mk-chat-steps')
  await expect(steps).toContainText('Found a problem, fixing it')
  await expect(steps.locator('li.mk-bad')).toHaveCount(1)
  await expect(steps).toContainText('Everything works')
  // the compile error is for the admin, not for the user
  expect(await page.getByTestId('mk-chat-body').innerText()).not.toMatch(/customer-card\.tsx|CardTitle|\d+:\d+/)
  const pill = page.getByTestId('status-pill')
  await expect(pill).toHaveText('active')
  // bg-emerald-100 exists only in the runtime CSS
  expect(await pill.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')

  await page.goto(adminUrl(page))
  await page.getByTestId('admin-row').first().click()
  const failed = page.getByTestId('admin-log-row').filter({ hasText: 'Commit rejected' })
  await expect(failed).toHaveAttribute('data-tool', 'finish')
  await expect(failed).toHaveAttribute('data-ok', 'false')
  await expect(failed).toContainText(/customer-card\.tsx:\d+:\d+/)
  await expect(page.getByTestId('admin-log-row')).toHaveCount(5)
})

test('chat scenario 4: an edit that throws while rendering is caught and rolled back automatically', async ({ page }) => {
  await openCrm(page)
  await expect(page.getByTestId('deals-table')).toContainText('Annual licence')
  const { turn } = await ask(page, 'Add a total row to the deals table')
  // it compiles, so the agent's result is applied ...
  await expect(turn).toHaveAttribute('data-status', 'applied')
  // ... and the panel's error boundary takes over
  const crash = page.getByTestId('morphkit-crash')
  await expect(crash).toBeVisible()
  await expect(crash).toContainText('Deals table exploded while rendering')
  await expect(page.getByTestId('customer-card')).toBeVisible()
  const started = Date.now()
  await expect(crash).toBeHidden({ timeout: 15_000 })
  expect(Date.now() - started).toBeGreaterThan(6_000)
  await expect(page.getByTestId('deals-table')).toContainText('Annual licence')
  await expect(page.getByTestId('mk-chat-undo')).toBeDisabled()
})
