import { expect, test } from '@playwright/test'
import { ask, openCrm, recordMetrics } from './chat-helpers'
import { shot } from './helpers'

// Opt-in: PLEATKIT_LIVE=1 and a key in PLEATKIT_API_KEY (or ANTHROPIC_API_KEY). Spends real tokens.
test.skip(process.env.PLEATKIT_LIVE !== '1', 'live Anthropic run: set PLEATKIT_LIVE=1 and PLEATKIT_API_KEY')

test('live: scenario 1 on claude-sonnet-5-5 through the chat, request to re-render', async ({ page }) => {
  await openCrm(page)
  const { turn, wallMs } = await ask(page, 'In the customer card add phone, city and source; highlight an overdue payment date in red')
  await expect(turn).toHaveAttribute('data-status', 'applied', { timeout: 120_000 })
  const card = page.getByTestId('customer-card')
  // the model writes its own markup, so check what the user sees, not test ids
  await expect(card).toContainText('+1 555 0102')
  await expect(card).toContainText('Springfield')
  await expect(card).toContainText('Referral')
  await shot(page, '13-live-anthropic.png')
  const m = {
    provider: 'anthropic',
    requestToRerenderMs: Number(await turn.getAttribute('data-total-ms')),
    agentMs: Number(await turn.getAttribute('data-agent-ms')),
    commitMs: Number(await turn.getAttribute('data-commit-ms')),
    wallClockMs: wallMs,
    modelCalls: Number(await turn.getAttribute('data-model-calls')),
    costUsd: Number(await turn.getAttribute('data-cost-usd')),
    usage: JSON.parse((await turn.getAttribute('data-usage')) ?? '[]'),
  }
  console.log('[metrics] live anthropic', JSON.stringify(m, null, 2))
  recordMetrics('liveAnthropicScenario1', m)
})
