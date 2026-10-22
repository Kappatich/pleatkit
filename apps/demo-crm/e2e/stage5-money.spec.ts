import { expect, test } from '@playwright/test'
import { appFor } from './helpers'

// DECISIONS 75 (brainstorm 16, Р2): the /admin Plan screen shows the expected cost of an edit on this app from the
// agent server. (The measured money of the pilot report, per organization, is a pleatkit cloud screen.)

test.use({ reducedMotion: 'reduce' })

test('DECISIONS 75: the Plan screen shows the expected cost per edit', async ({ page }) => {
  const app = appFor(page)
  await page.goto(`/admin?view=plan&app=${app}`)
  await expect(page.getByTestId('admin-plan-money')).toBeVisible()
  // the demo's agent is scripted: estimated from the manifest and priced as the default models
  const expected = page.getByTestId('admin-plan-expected')
  await expect(expected).toHaveAttribute('data-source', 'estimated')
  await expect(page.getByTestId('admin-plan-expected-value')).toHaveText(/^\$0\.0\d{3}$/)
  await expect(expected).toContainText('claude-sonnet-5-5, prompt size estimated; cold (first edit after 5 min idle): $0.0')
  // the open store has no pilot report: nothing on this screen asks for it
  await expect(page.getByTestId('admin-plan-org')).toHaveCount(0)
})
