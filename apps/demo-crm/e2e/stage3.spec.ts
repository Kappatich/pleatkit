import { expect, test, type Page } from '@playwright/test'
import { adminUrl, ask, openChat, openCrm } from './chat-helpers'
import { appFor } from './helpers'

const SCENARIO_1 = 'In the customer card add phone, city and source; highlight an overdue payment date in red'

async function setModeration(page: Page, on: boolean): Promise<void> {
  await page.goto(adminUrl(page))
  const toggle = page.getByTestId('admin-moderation-toggle')
  await expect(toggle).toBeEnabled()
  if ((await toggle.isChecked()) !== on) await toggle.click()
  await expect(toggle).toBeChecked({ checked: on })
}

test('moderation review: the edit applies at once, waits at the top of /admin, approve or one-click rollback (DECISIONS 15)', async ({ page }) => {
  await setModeration(page, true)

  await openCrm(page)
  const { turn } = await ask(page, SCENARIO_1)
  await expect(turn).toHaveAttribute('data-status', 'applied')
  await expect(page.getByTestId('customer-card').getByTestId('phone')).toBeVisible()
  await expect(turn).toHaveAttribute('data-review', 'pending')
  await expect(turn.getByTestId('mk-chat-review')).toHaveText('Your admin will review this.')

  // a backend request after it: still, the edit awaiting review is listed first
  await ask(page, 'Add a discount field to deals and recalculate the amount on the server')

  await page.goto(adminUrl(page))
  await expect(page.getByTestId('stat-review')).toHaveText('1')
  await expect(page.getByTestId('admin-review-chip')).toHaveText('Review: on')
  // the "Awaiting review" chip filters the table to what waits on the admin
  await expect(page.getByTestId('admin-row')).toHaveCount(2)
  await page.getByTestId('admin-filter-review').click()
  await expect(page.getByTestId('admin-row')).toHaveCount(1)
  const first = page.getByTestId('admin-row').first()
  await expect(first).toHaveAttribute('data-status', 'pending-review')
  await expect(first.getByTestId('admin-status')).toContainText('awaiting review')
  await first.click()
  await page.getByTestId('admin-approve').click()
  await expect(page.getByTestId('admin-msg')).toHaveText('Approved.')
  await expect(page.locator('[data-testid="admin-row"][data-status="applied"]')).toHaveCount(1)
  // nothing awaits review any more: the chip goes away and the table shows everything again
  await expect(page.getByTestId('stat-review')).toHaveCount(0)
  await expect(page.getByTestId('admin-row')).toHaveCount(2)

  // a second reviewed edit is rolled back for the user with one click
  await openCrm(page)
  const second = await ask(page, 'Make the customer name bigger and show the status as a coloured pill')
  await expect(second.turn).toHaveAttribute('data-review', 'pending')
  await page.goto(adminUrl(page))
  const pending = page.locator('[data-testid="admin-row"][data-status="pending-review"]')
  await pending.click()
  await page.getByTestId('admin-rollback').click()
  await expect(page.getByTestId('admin-msg')).toHaveText('Rolled back for the user.')
  await openCrm(page)
  await expect(page.getByTestId('status-pill')).toHaveCount(0)
  // the approved edit before it is still there
  await expect(page.getByTestId('customer-card').getByTestId('phone')).toBeVisible()
})

test('moderation off (default): edits are just applied', async ({ page }) => {
  await openCrm(page)
  const { turn } = await ask(page, SCENARIO_1)
  await expect(turn).toHaveAttribute('data-status', 'applied')
  await expect(turn).not.toHaveAttribute('data-review', /.*/)
  await page.goto(adminUrl(page))
  await expect(page.getByTestId('admin-moderation-toggle')).not.toBeChecked()
  await expect(page.getByTestId('admin-review-chip')).toHaveText('Review: off')
  await expect(page.getByTestId('admin-row').first()).toHaveAttribute('data-status', 'applied')
})

test('pointing at a panel skips the classifier (DECISIONS 17)', async ({ page }) => {
  await openCrm(page)
  const { turn } = await ask(page, '[panel: customer-card] add phone, city and source')
  await expect(turn).toHaveAttribute('data-status', 'applied')
  const steps = turn.getByTestId('mk-chat-steps')
  await expect(steps).not.toContainText('Understanding the request')
  await expect(steps.locator('li').first()).toHaveText('Planning the change')
  await page.goto(adminUrl(page))
  await page.getByTestId('admin-row').first().click()
  await expect(page.getByTestId('admin-detail')).toContainText('classified —')
})

test('Russian interface: chat, progress lines and admin through the en/ru dictionary (DECISIONS 20)', async ({ page }) => {
  await page.goto(`/?user=alice&app=${appFor(page)}&lang=ru`)
  await page.getByRole('button', { name: /Globex/ }).click()
  await expect(page.getByTestId('mk-chat-open')).toHaveText('Настроить')
  await openChat(page)
  await expect(page.getByTestId('mk-chat-send')).toHaveAttribute('aria-label', 'Отправить')
  await expect(page.getByTestId('mk-chat-input')).toHaveAttribute('placeholder', /скриншот/)
  const { turn } = await ask(page, 'В карточке клиента добавь телефон, город и источник; просроченную дату выделяй красным')
  await expect(turn).toHaveAttribute('data-status', 'applied')
  await expect(page.getByTestId('mk-chat-undo')).toBeEnabled()
  const steps = turn.getByTestId('mk-chat-steps')
  await expect(steps).toContainText('Меняю панель «customer card»')
  await expect(steps).toContainText('Всё работает')
  await expect(steps).not.toContainText(/Changing|Checking/)

  await page.getByTestId('mk-chat-close').click()
  await page.getByRole('link', { name: 'Admin' }).click()
  await expect(page).toHaveURL(/\/admin\?.*lang=ru/)
  await expect(page.getByTestId('admin')).toContainText('За неделю: запросов 1 · применено 1')
  await expect(page.getByTestId('admin-row').first().getByTestId('admin-status')).toContainText('применена')
})

test('English is the default language', async ({ page }) => {
  await openCrm(page)
  await expect(page.getByTestId('mk-chat-open')).toHaveText('Customize')
  await page.goto(adminUrl(page))
  await expect(page.getByTestId('admin')).toContainText('This week: 0 requests · 0 applied')
})

// The demo serves the page under the README's strict CSP with ?csp=strict (no 'unsafe-inline' for scripts).
test('isolated panel works under a strict CSP: no inline script, host loaded with CORS', async ({ page }) => {
  const violations: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text())
  })
  const hostRequests: { url: string; origin: string | null; cors: string | null }[] = []
  page.on('response', (r) => {
    if (r.url().includes('morphkit-isolated-host-')) hostRequests.push({ url: r.url(), origin: r.request().headers()['origin'] ?? null, cors: r.headers()['access-control-allow-origin'] ?? null })
  })

  const doc = await page.goto(`/?user=alice&app=${appFor(page)}&isolated=1&dev=1&csp=strict&compile=browser`)
  expect(doc?.headers()['content-security-policy']).toContain("script-src 'self' blob: 'wasm-unsafe-eval'")
  const iframe = page.getByTestId('morphkit-isolated-dashboard-panels')
  const frame = page.frameLocator('[data-testid="morphkit-isolated-dashboard-panels"]')
  await expect(frame.getByTestId('dashboard-panels')).toContainText('Open pipeline')

  const srcdoc = (await iframe.getAttribute('srcdoc')) ?? ''
  expect(srcdoc).toMatch(/<script src="http:\/\/localhost:\d+\/assets\/morphkit-isolated-host-[0-9a-f]+\.js" crossorigin="anonymous"><\/script>/)
  expect(srcdoc).not.toMatch(/<script>/)
  expect(hostRequests).toHaveLength(1)
  expect(hostRequests[0]).toMatchObject({ origin: 'null', cors: '*' })

  // a commit compiled in the browser (esbuild-wasm, Tailwind) still reaches the frame under the same CSP
  await page.getByTestId('mk-file').selectOption('src/dynamic/dashboard-panels.tsx')
  const source = page.getByTestId('mk-source')
  await source.fill((await source.inputValue()).replace("label: 'Open pipeline'", "label: 'Pipeline under CSP'"))
  await page.getByTestId('mk-commit').click()
  await expect(page.getByTestId('mk-status')).toContainText('Committed')
  await expect(frame.getByTestId('dashboard-panels')).toContainText('Pipeline under CSP')
  expect(violations).toEqual([])
})
