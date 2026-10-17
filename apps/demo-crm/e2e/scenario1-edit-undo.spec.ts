import { expect, test } from '@playwright/test'
import { CARD, editFile, fixture, openApp, readMetrics, shot } from './helpers'

test('scenario 1: add phone/city/source + red overdue date via dev panel, commit, undo, redo', async ({ page }) => {
  await openApp(page)
  const card = page.getByTestId('customer-card')
  await expect(card.getByTestId('phone')).toHaveCount(0)
  await expect(card.getByTestId('due-date')).not.toHaveClass(/text-red-600/)
  await shot(page, '01-base.png')

  await editFile(page, CARD, fixture('customer-card.scenario1.tsx'))
  await page.getByTestId('mk-check').click()
  await expect(page.getByTestId('mk-result')).toHaveAttribute('data-ok', 'true')
  // check alone must not change the app
  await expect(card.getByTestId('phone')).toHaveCount(0)

  const started = Date.now()
  await page.getByTestId('mk-commit').click()
  await expect(card.getByTestId('phone')).toHaveText('+1 555 0102')
  const commitToRenderMs = Date.now() - started
  await expect(card.getByTestId('city')).toHaveText('Springfield')
  await expect(card.getByTestId('source')).toHaveText('Referral')
  await expect(page.getByTestId('mk-status')).toContainText('Committed')

  const due = card.getByTestId('due-date')
  await expect(due).toHaveAttribute('data-overdue', 'true')
  await expect(due).toHaveClass(/text-red-600/)
  const dueColor = await due.evaluate((el) => getComputedStyle(el).color)
  const plainColor = await card.getByTestId('city').evaluate((el) => getComputedStyle(el).color)
  expect(dueColor).not.toBe(plainColor)
  await shot(page, '02-scenario1-committed.png')

  // a customer that is not overdue keeps the normal colour
  await page.getByRole('button', { name: /Initech/ }).click()
  await expect(card.getByTestId('due-date')).toHaveAttribute('data-overdue', 'false')
  await expect(card.getByTestId('phone')).toHaveText('+1 555 0147')
  await page.getByRole('button', { name: /Globex/ }).click()

  await page.getByTestId('mk-undo').click()
  await expect(card.getByTestId('phone')).toHaveCount(0)
  await expect(card.getByTestId('due-date')).not.toHaveClass(/text-red-600/)
  await expect(page.getByTestId('mk-head')).toContainText('(base)')
  await shot(page, '03-scenario1-undo.png')

  await page.getByTestId('mk-redo').click()
  await expect(card.getByTestId('phone')).toHaveText('+1 555 0102')
  await page.getByTestId('mk-undo').click()
  await expect(card.getByTestId('phone')).toHaveCount(0)

  const m = await readMetrics(page)
  console.log(
    `[metrics] scenario 1: commit click -> new card visible ${commitToRenderMs} ms ` +
      `(engine commit ${m.lastCommitMs?.toFixed(0)} ms, check ${m.lastCheckMs?.toFixed(0)} ms, swap ${m.lastSwapMs?.toFixed(1)} ms)`,
  )
})
