import { expect, test } from '@playwright/test'
import { CARD, editFile, fixture, openApp, shot } from './helpers'

test('scenario 3: a draft that does not compile is rejected with a structured error; the fix then commits', async ({ page }) => {
  await openApp(page)
  const card = page.getByTestId('customer-card')

  await editFile(page, CARD, fixture('customer-card.broken.tsx'))
  await page.getByTestId('mk-commit').click()

  await expect(page.getByTestId('mk-status')).toContainText('Commit rejected')
  await expect(page.getByTestId('mk-result')).toHaveAttribute('data-ok', 'false')
  const error = page.getByTestId('mk-error').first()
  await expect(error).toHaveAttribute('data-file', CARD)
  await expect(error).toHaveAttribute('data-line', /^[1-9]\d*$/)
  await expect(error).toHaveAttribute('data-column', /^[1-9]\d*$/)
  await expect(error).toContainText(/CardHeader|CardTitle/)
  console.log(`[e2e] structured compile error: ${await error.textContent()}`)

  // nothing applied: the original card is still live and head did not move
  await expect(card.getByTestId('due-date')).toBeVisible()
  await expect(card).toContainText('globex.example')
  await expect(page.getByTestId('mk-head')).toContainText('head: base')
  await page.locator('summary', { hasText: 'History' }).click()
  await expect(page.getByTestId('mk-history')).toContainText('rejected')
  await shot(page, '04-scenario3-rejected.png')

  // second iteration ("the agent fixes it"): the corrected file commits
  await page.getByTestId('mk-source').fill(fixture('customer-card.scenario1.tsx'))
  await page.getByTestId('mk-commit').click()
  await expect(card.getByTestId('phone')).toHaveText('+1 555 0102')
  await expect(page.getByTestId('mk-result')).toHaveAttribute('data-ok', 'true')
})
