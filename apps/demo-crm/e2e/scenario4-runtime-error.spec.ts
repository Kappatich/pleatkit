import { expect, test } from '@playwright/test'
import { DEALS, editFile, fixture, openApp, shot } from './helpers'

test('scenario 4: a render-time throw shows the error boundary and rolls back automatically after 10 s', async ({ page }) => {
  await openApp(page)
  await expect(page.getByTestId('deals-table')).toContainText('Annual licence')

  await editFile(page, DEALS, fixture('deals-table.throws.tsx'))
  await page.getByTestId('mk-commit').click()
  // compiles and evaluates fine, so the commit itself succeeds
  await expect(page.getByTestId('mk-status')).toContainText('Committed')

  const crash = page.getByTestId('pleatkit-crash')
  await expect(crash).toBeVisible()
  await expect(crash).toContainText('Deals table exploded while rendering')
  await expect(crash).toContainText('Rolling back automatically')
  // the other dynamic panels keep working
  await expect(page.getByTestId('customer-card')).toBeVisible()
  await expect(page.getByTestId('dashboard-panels')).toBeVisible()
  await shot(page, '05-scenario4-crash.png')

  const started = Date.now()
  await expect(crash).toBeHidden({ timeout: 15_000 })
  const waited = Date.now() - started
  expect(waited).toBeGreaterThan(7_000)
  await expect(page.getByTestId('deals-table')).toContainText('Annual licence')
  await expect(page.getByTestId('mk-head')).toContainText('(base)')
  await shot(page, '06-scenario4-rolled-back.png')
  console.log(`[e2e] auto-rollback happened ${waited} ms after the crash banner was observed`)
})

test('scenario 4b: "Roll back" in the crash banner reverts immediately', async ({ page }) => {
  await openApp(page)
  await editFile(page, DEALS, fixture('deals-table.throws.tsx'))
  await page.getByTestId('mk-commit').click()
  const crash = page.getByTestId('pleatkit-crash')
  await expect(crash).toBeVisible()
  await crash.getByRole('button', { name: 'Roll back' }).click()
  await expect(crash).toBeHidden({ timeout: 2_000 })
  await expect(page.getByTestId('deals-table')).toContainText('Annual licence')
})
