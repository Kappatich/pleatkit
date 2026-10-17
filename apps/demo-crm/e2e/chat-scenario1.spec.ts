import { expect, test } from '@playwright/test'
import { ask, openChat, openCrm, recordMetrics } from './chat-helpers'
import { shot } from './helpers'

test('chat scenario 1: agent adds phone/city/source and a red overdue date; Tailwind classes compiled at runtime; undo from the chat', async ({ page }) => {
  await openCrm(page)
  const card = page.getByTestId('customer-card')
  await expect(card.getByTestId('phone')).toHaveCount(0)

  // opening the chat preloads esbuild-wasm and the Tailwind compiler (done well before a user finishes typing)
  await openChat(page)
  await expect(page.getByTestId('mk-chat-body')).toContainText('Describe what you want to change')
  await expect(page.getByTestId('mk-chat')).toHaveAttribute('data-warm', 'true')

  const { turn, wallMs } = await ask(page, 'In the customer card add phone, city and source; highlight an overdue payment date in red')
  await expect(turn).toHaveAttribute('data-status', 'applied')
  await expect(card.getByTestId('phone')).toHaveText('+1 555 0102')
  await expect(card.getByTestId('city')).toHaveText('Springfield')
  await expect(card.getByTestId('source')).toHaveText('Referral')
  await expect(page.getByTestId('mk-toast').filter({ hasText: 'Applied' })).toBeVisible()

  // progress streamed from the agent, in order
  const steps = turn.getByTestId('mk-chat-steps')
  for (const s of ['Understanding the request', "Looking at the app's data and helpers", 'Changing the customer card', 'Checking that everything still works', 'Everything works']) {
    await expect(steps).toContainText(s)
  }
  await expect(turn.getByTestId('mk-chat-summary')).toContainText('overdue payment date is highlighted in red')
  // the end user never sees code, file names or diffs in the chat (DECISIONS item 10)
  const chatText = await page.getByTestId('mk-chat-body').innerText()
  expect(chatText).not.toMatch(/\.tsx?\b|src\/|import |export |=>|<\/?[A-Za-z]|className|customer\.meta/)
  await expect(turn.getByTestId('mk-turn-undo')).toBeEnabled()
  await expect(turn.getByTestId('mk-turn-history')).toBeVisible()

  // CSS for classes the edit introduced, compiled in the browser: palette colour + arbitrary values
  const due = card.getByTestId('due-date')
  await expect(due).toHaveAttribute('data-overdue', 'true')
  expect(await due.evaluate((el) => getComputedStyle(el).color)).not.toBe(await card.getByTestId('city').evaluate((el) => getComputedStyle(el).color))
  const chip = card.getByTestId('overdue-chip')
  expect(await chip.evaluate((el) => getComputedStyle(el).fontSize)).toBe('11px')
  expect(await chip.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('3px')
  expect(await chip.evaluate((el) => getComputedStyle(el).paddingLeft)).toBe('6px')
  const runtimeCss = await page.evaluate(() => document.querySelector('style[data-morphkit-css]')?.textContent ?? '')
  expect(runtimeCss).toContain('text-\\[11px\\]')
  expect(runtimeCss.length).toBeLessThan(40_000)
  await shot(page, '08-chat-applied.png')

  const totalMs = Number(await turn.getAttribute('data-total-ms'))
  const agentMs = Number(await turn.getAttribute('data-agent-ms'))
  const commitMs = Number(await turn.getAttribute('data-commit-ms'))
  console.log(
    `[metrics] chat scenario 1 (scripted provider): request -> re-render ${totalMs} ms in the page ` +
      `(agent round trip incl. classify + 3 scripted turns + server check ${agentMs} ms, browser commit + paint ${commitMs} ms), ${wallMs} ms wall clock in Playwright`,
  )
  recordMetrics('chatScenario1', { provider: 'scripted', requestToRerenderMs: totalMs, agentMs, commitMs, wallClockMs: wallMs, runtimeCssBytes: runtimeCss.length })

  // undo from the result in the chat
  await turn.getByTestId('mk-turn-undo').click()
  await expect(card.getByTestId('phone')).toHaveCount(0)
  await expect(page.getByTestId('mk-toast').filter({ hasText: 'Undone' })).toBeVisible()
  await page.getByTestId('mk-chat-history').click()
  await expect(page.getByTestId('mk-history')).toContainText('Original version')
  await expect(page.getByTestId('mk-history')).toContainText('In the customer card add phone')
})

test('chat, cold: a request sent the instant the chat opens still applies (compilers load on demand)', async ({ page }) => {
  await openCrm(page)
  const { turn } = await ask(page, 'In the customer card add phone, city and source; highlight an overdue payment date in red')
  await expect(turn).toHaveAttribute('data-status', 'applied')
  const m = { requestToRerenderMs: Number(await turn.getAttribute('data-total-ms')), agentMs: Number(await turn.getAttribute('data-agent-ms')), commitMs: Number(await turn.getAttribute('data-commit-ms')) }
  console.log(`[metrics] chat scenario 1, cold (sent before warmup finished): ${JSON.stringify(m)}`)
  recordMetrics('chatScenario1Cold', { provider: 'scripted', ...m })
})

test('chat: a request that has no recorded answer fails politely and changes nothing', async ({ page }) => {
  await openCrm(page)
  const { turn } = await ask(page, 'Make everything purple and add confetti')
  await expect(turn).toHaveAttribute('data-status', 'failed')
  await expect(turn).toContainText('MORPHKIT_API_KEY')
  await expect(page.getByTestId('mk-chat-undo')).toBeDisabled()
})
