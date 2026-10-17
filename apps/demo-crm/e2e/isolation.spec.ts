import { expect, test } from '@playwright/test'
import { CARD, editFile, fixture, openApp, readMetrics, shot } from './helpers'

test('per-user isolation: an edit by alice is not visible for bob, and survives reloads', async ({ page }) => {
  await openApp(page, 'alice')
  const card = page.getByTestId('customer-card')
  await editFile(page, CARD, fixture('customer-card.scenario1.tsx'))
  await page.getByTestId('mk-commit').click()
  await expect(card.getByTestId('phone')).toHaveText('+1 555 0102')

  await page.getByTestId('user-switch').selectOption('bob')
  await page.getByRole('button', { name: /Globex/ }).click()
  await expect(card).toContainText('Globex')
  await expect(card.getByTestId('phone')).toHaveCount(0)
  await expect(page.getByTestId('mk-head')).toContainText('head: base')
  await shot(page, '07-isolation-bob.png')

  await page.getByTestId('user-switch').selectOption('alice')
  await page.getByRole('button', { name: /Globex/ }).click()
  await expect(card.getByTestId('phone')).toHaveText('+1 555 0102')

  // a fresh page load restores alice's version from the bundle cache without starting esbuild
  await openApp(page, 'alice')
  await expect(card.getByTestId('phone')).toHaveText('+1 555 0102')
  expect((await readMetrics(page)).initMs).toBeNull()

  await openApp(page, 'bob')
  await expect(card.getByTestId('phone')).toHaveCount(0)
})
