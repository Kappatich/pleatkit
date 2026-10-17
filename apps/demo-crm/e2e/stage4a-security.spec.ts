import { expect, test } from '@playwright/test'
import { ask, openChat, openCrm } from './chat-helpers'
import { appFor } from './helpers'

const SCENARIO_1 = 'In the customer card add phone, city and source; highlight an overdue payment date in red'
const SECURE_APP = 'e2e-secure'

test('A1: with user tokens the chat edit works end to end, and the development headers are refused for that app', async ({ page, request }) => {
  const calls: { url: string; auth: string | null }[] = []
  page.on('request', (r) => {
    if (r.url().includes('/morphkit-store/') || r.url().includes('/agent/')) calls.push({ url: r.url(), auth: r.headers()['authorization'] ?? null })
  })
  await page.goto(`/?user=alice&app=${SECURE_APP}&auth=token`)
  await page.getByRole('button', { name: /Globex/ }).click()
  const { turn } = await ask(page, SCENARIO_1)
  await expect(turn).toHaveAttribute('data-status', 'applied')
  await expect(page.getByTestId('customer-card').getByTestId('phone')).toBeVisible()
  // every call to store-server and the agent carried the user token
  const api = calls.filter((c) => !c.url.includes('/v1/b/'))
  expect(api.length).toBeGreaterThan(3)
  expect(api.every((c) => c.auth?.startsWith('Bearer ey'))).toBe(true)

  // the edit survives a reload (read back with the token)
  await page.reload()
  await page.getByRole('button', { name: /Globex/ }).click()
  await expect(page.getByTestId('customer-card').getByTestId('phone')).toBeVisible()

  // A3: in this mode the page runs only bundles signed by the app key; a bundle altered on the way is refused
  // and the original version is shown instead
  const signature = (await (await request.get((await page.locator('script[data-morphkit-bundle]').first().getAttribute('src'))!.replace(/\.js$/, '.json'))).json()) as { sig?: string }
  expect(signature.sig).toBeTruthy()
  await page.route('**/morphkit/b/**/*.css', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '.x{background:url(https://evil.test/leak)}' }))
  await page.reload()
  await page.getByRole('button', { name: /Globex/ }).click()
  await expect(page.getByTestId('customer-card')).toBeVisible()
  await expect(page.getByTestId('customer-card').getByTestId('phone')).toHaveCount(0)
  await page.unroute('**/morphkit/b/**/*.css')

  // anyone sending the development headers for this app is refused
  const forged = await request.get('/morphkit-store/v1/heads/alice', { headers: { 'x-morphkit-user': 'alice', 'x-morphkit-app': SECURE_APP } })
  expect(forged.status()).toBe(401)
  const forgedAgent = await request.post('/agent/v1/run', { data: { userId: 'alice', appId: SECURE_APP, request: 'x', files: {}, context: { dynamicRoots: [], externals: [], externalPatterns: [], alias: {} } } })
  expect(forgedAgent.status()).toBe(401)
})

test('A5: the chat drawer says that AI answers can be inaccurate (en and ru)', async ({ page }) => {
  await openCrm(page)
  await openChat(page)
  await expect(page.getByTestId('mk-chat-disclaimer')).toHaveText('AI answers can be inaccurate. Check the result.')
  await page.goto(`/?user=alice&app=${appFor(page)}&lang=ru`)
  await openChat(page)
  await expect(page.getByTestId('mk-chat-disclaimer')).toHaveText('Ответы ИИ могут быть неточными, проверьте результат.')
})

test('A4: an off-topic request gets one fixed reply and changes nothing', async ({ page }) => {
  await openCrm(page)
  const before = await page.getByTestId('customer-card').innerHTML()
  const { turn } = await ask(page, 'Write me a poem about the sea')
  await expect(turn).toHaveAttribute('data-status', 'refused')
  await expect(turn.getByTestId('mk-chat-summary')).toHaveText('I can only change how this app looks and works for you. Ask me about its pages and panels.')
  await expect(turn).toHaveAttribute('data-model-calls', '0')
  expect(await page.getByTestId('customer-card').innerHTML()).toBe(before)
})

test('A4: over the daily edit limit of the plan (per-app data), the next request is refused politely', async ({ page, request }) => {
  await openCrm(page)
  const app = appFor(page)
  const plan = await request.put('/morphkit-store/v1/admin/plan', { headers: { 'x-morphkit-admin': '1', 'x-morphkit-app': app }, data: { plan: 'trial', limits: { userDailyEdits: 1 } } })
  expect(plan.ok()).toBe(true)
  const first = await ask(page, SCENARIO_1)
  await expect(first.turn).toHaveAttribute('data-status', 'applied')
  const second = await ask(page, 'Add a discount field to deals and recalculate the amount on the server')
  await expect(second.turn).toHaveAttribute('data-status', 'refused')
  await expect(second.turn.getByTestId('mk-chat-summary')).toContainText('today’s limit')
})
