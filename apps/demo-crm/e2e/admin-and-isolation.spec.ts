import { expect, test } from '@playwright/test'
import { adminUrl, ask, openCrm } from './chat-helpers'
import { shot } from './helpers'

const SCENARIO_1 = 'In the customer card add phone, city and source; highlight an overdue payment date in red'

test('per-user isolation through the chat: alice’s edit is not visible to bob and survives reloads', async ({ page }) => {
  await openCrm(page, { user: 'alice' })
  const card = page.getByTestId('customer-card')
  const { turn } = await ask(page, SCENARIO_1)
  await expect(turn).toHaveAttribute('data-status', 'applied')
  await expect(card.getByTestId('phone')).toHaveText('+1 555 0102')

  await page.getByTestId('user-switch').selectOption('bob')
  await page.getByRole('button', { name: /Globex/ }).click()
  await expect(card).toContainText('Globex')
  await expect(card.getByTestId('phone')).toHaveCount(0)
  // the chat belongs to the signed-in user: bob has nothing to undo
  await page.getByTestId('mk-chat-open').click()
  await expect(page.getByTestId('mk-chat-undo')).toBeDisabled()

  // a fresh page load: alice's version comes back from store-server (snapshot + cached bundle)
  await openCrm(page, { user: 'alice' })
  await expect(card.getByTestId('phone')).toHaveText('+1 555 0102')
  await openCrm(page, { user: 'bob' })
  await expect(card.getByTestId('phone')).toHaveCount(0)
})

test('admin dashboard: counters, diff vs parent, tool log, and rolling a user back', async ({ page }) => {
  await openCrm(page, { user: 'alice' })
  await expect((await ask(page, SCENARIO_1)).turn).toHaveAttribute('data-status', 'applied')
  await openCrm(page, { user: 'bob' })
  await expect((await ask(page, 'Add a discount field to deals and recalculate the amount on the server')).turn).toHaveAttribute('data-status', 'needs-backend')

  await page.goto(adminUrl(page))
  await expect(page.getByTestId('admin-row')).toHaveCount(2)
  await expect(page.getByTestId('stat-edits')).toHaveText('1')
  await expect(page.getByTestId('stat-total')).toHaveText('2')
  await expect(page.getByTestId('stat-success')).toHaveText('50%')
  await expect(page.getByTestId('stat-backend')).toHaveText('50%')

  const alice = page.getByTestId('admin-row').filter({ hasText: 'alice' })
  await expect(alice).toHaveAttribute('data-status', 'applied')
  await expect(alice).toContainText('live')
  await alice.click()
  const diff = page.getByTestId('admin-diff')
  await expect(diff).toHaveAttribute('data-file', 'src/dynamic/customer-card.tsx')
  await expect(diff).toContainText('+ ')
  await expect(diff).toContainText('data-testid="phone"')
  await expect(page.getByTestId('admin-log-row')).toHaveCount(4)
  await shot(page, '09-admin.png')

  await page.getByTestId('admin-rollback').click()
  await expect(page.getByTestId('admin-msg')).toHaveText('Rolled back for the user.')
  await expect(alice).toHaveAttribute('data-status', 'rolled-back')

  // alice gets the original card back on her next load
  const app = new URL(page.url()).searchParams.get('app')
  await page.goto(`/?user=alice&app=${app}`)
  await page.getByRole('button', { name: /Globex/ }).click()
  await expect(page.getByTestId('customer-card')).toContainText('globex.example')
  await expect(page.getByTestId('customer-card').getByTestId('phone')).toHaveCount(0)
})

test('element picker: pointing at a panel mentions it in the request', async ({ page }) => {
  await openCrm(page)
  await page.getByTestId('mk-chat-open').click()
  await page.getByTestId('mk-chat-pick').click()
  const card = page.getByTestId('customer-card')
  const box = (await card.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.getByTestId('mk-pick-box')).toHaveAttribute('data-panel', 'customer-card')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.getByTestId('mk-pick-layer')).toHaveCount(0)
  await expect(page.getByTestId('mk-chat-pick')).toContainText('customer-card')
  await page.getByTestId('mk-chat-input').pressSequentially('add phone, city and source')
  await page.getByTestId('mk-chat-send').click()
  await expect(page.getByTestId('mk-chat-turn').first()).toHaveAttribute('data-status', 'applied')
  await expect(card.getByTestId('phone')).toBeVisible()
})
