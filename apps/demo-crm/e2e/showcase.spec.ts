import { expect, test, type Page } from '@playwright/test'
import { adminUrl, ask, openCrm, SHOWCASE } from './chat-helpers'

// The showcase requests (the film's "What else customers ask for"): four recorded answers that build real panels
// from the CRM's data (e2e/fixtures/agent/08-11, panels in e2e/fixtures/showcase/). Each is applied by the drawer,
// undone from it, and shows its diff in the admin view; the animations stop for reduced motion.

/** yyyy-mm of the month `offset` months from now (the demo data is dated relative to the server's start). */
function monthKey(offset: number): string {
  const now = new Date()
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

async function applied(page: Page, request: string): Promise<void> {
  const { turn } = await ask(page, request)
  await expect(turn).toHaveAttribute('data-status', 'applied')
}

test('showcase 1: the deals table becomes a revenue chart with a forecast and the best month; undo; the admin diff', async ({ page }) => {
  await openCrm(page)
  await expect(page.getByTestId('deals-table')).toContainText('Annual licence')
  await applied(page, SHOWCASE.chart)

  const chart = page.getByTestId('revenue-chart')
  await expect(chart).toBeVisible()
  await expect(page.getByTestId('deals-table')).toHaveCount(0)
  // twelve complete months of won deals, all customers; the best one is three months back
  await expect(chart.getByTestId('revenue-bar')).toHaveCount(12)
  await expect(chart.getByTestId('revenue-bar').first()).toHaveAttribute('data-month', monthKey(-12))
  await expect(chart.getByTestId('revenue-total')).toHaveText('$1,037,400')
  const best = chart.getByTestId('best-month')
  await expect(best).toHaveAttribute('data-month', monthKey(-3))
  await expect(best).toHaveText('$128,400') // after the count-up
  await expect(chart.getByTestId('revenue-forecast')).toHaveCount(1)
  await expect(chart.getByTestId('forecast-value')).toHaveText(['$119k', '$124k', '$129k'])
  // the best bar is red, the others are ink; the animations are CSS, from the edit's own stylesheet
  const fills = await chart.getByTestId('revenue-bar').evaluateAll((bars) => bars.map((b) => getComputedStyle(b).fill))
  expect(new Set(fills).size).toBe(2)
  expect(await chart.locator('.rc-bar').first().evaluate((b) => getComputedStyle(b).animationName)).toBe('rc-grow')

  await page.getByTestId('mk-chat-undo').click()
  await expect(page.getByTestId('deals-table')).toContainText('Annual licence')
  await expect(page.getByTestId('revenue-chart')).toHaveCount(0)

  await page.goto(adminUrl(page))
  const row = page.getByTestId('admin-row').first()
  await expect(row).toHaveAttribute('data-status', 'applied')
  await row.click()
  const files = await page.getByTestId('admin-diff').evaluateAll((d) => d.map((e) => e.getAttribute('data-file')))
  expect(files.sort()).toEqual(['src/dynamic/deals-table.tsx', 'src/dynamic/revenue-chart.css'])
  await expect(page.getByTestId('admin-diff').filter({ hasText: 'rc-dash' })).toHaveCount(1)
})

test('showcase 2-4: retention heatmap, kanban board, pivot table, one after another; undo walks back', async ({ page }) => {
  await openCrm(page)

  await applied(page, SHOWCASE.heatmap)
  const heatmap = page.getByTestId('retention-heatmap')
  await expect(heatmap.getByTestId('cohort-row')).toHaveCount(6)
  // six cohorts, the oldest with six months after signup, the newest with one: 21 cells
  await expect(heatmap.getByTestId('retention-cell')).toHaveCount(21)
  await expect(heatmap.getByTestId('cohort-row').first()).toHaveAttribute('data-cohort', monthKey(-7))
  await expect(heatmap.getByTestId('retention-cell').first()).toHaveAttribute('data-share', '81')
  await expect(heatmap.getByTestId('month-one-retention')).toHaveText('88%')
  // the colour goes from paper to red with the share kept
  const [low, high] = await heatmap.getByTestId('retention-cell').evaluateAll((cells) => {
    const shares = cells.map((c) => Number(c.getAttribute('data-share')))
    const at = (s: number) => getComputedStyle(cells[shares.indexOf(s)]!).backgroundColor
    return [at(Math.min(...shares)), at(Math.max(...shares))]
  })
  expect(low).not.toBe(high)
  // the dashboard keeps its numbers next to the heatmap
  await expect(page.getByTestId('dashboard-panels')).toContainText('Open pipeline')
  await expect(page.getByTestId('dashboard-panels')).toContainText('$411,000')

  await applied(page, SHOWCASE.kanban)
  const board = page.getByTestId('deals-kanban')
  await expect(board.getByTestId('kanban-column')).toHaveCount(4)
  await expect(board.getByTestId('kanban-card')).toHaveCount(13)
  await expect(board.getByTestId('column-total')).toHaveText(['$72,000', '$84,500', '$143,000', '$111,500'])
  await expect(board.getByTestId('kanban-column').first()).toHaveAttribute('data-step', 'Qualified')

  await applied(page, SHOWCASE.pivot)
  const pivot = page.getByTestId('pipeline-pivot')
  await expect(pivot.getByTestId('pivot-row')).toHaveCount(6)
  await expect(pivot.getByTestId('pivot-subtotal')).toHaveCount(3)
  await expect(pivot.getByTestId('pivot-subtotal').first()).toContainText('$160,500')
  await expect(pivot.getByTestId('pivot-grand-total')).toContainText('$411,000')
  await expect(pivot.getByTestId('pivot-grand-total')).toContainText('13')
  // the heatmap is still on the dashboard: each request changed one panel
  await expect(heatmap).toBeVisible()

  const undo = page.getByTestId('mk-chat-undo')
  await undo.click()
  await expect(page.getByTestId('deals-kanban')).toBeVisible()
  await undo.click()
  await expect(page.getByTestId('deals-table')).toContainText('Annual licence')
  await undo.click()
  await expect(page.getByTestId('retention-heatmap')).toHaveCount(0)
  await expect(page.getByTestId('dashboard-panels')).toContainText('Open pipeline')

  await page.goto(adminUrl(page))
  await expect(page.getByTestId('admin-row')).toHaveCount(3)
  await page.getByTestId('admin-row').filter({ hasText: 'heatmap' }).click()
  const files = await page.getByTestId('admin-diff').evaluateAll((d) => d.map((e) => e.getAttribute('data-file')))
  expect(files.sort()).toEqual(['src/dynamic/dashboard-panels.tsx', 'src/dynamic/retention-heatmap.css'])
})

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' })

  test('showcase panels stand still: no CSS animation, the counted numbers at their final value at once', async ({ page }) => {
    await openCrm(page)
    await applied(page, SHOWCASE.chart)
    const chart = page.getByTestId('revenue-chart')
    await expect(chart.getByTestId('best-month')).toHaveText('$128,400')
    for (const sel of ['.rc-bar', '.rc-bar-best', '.rc-forecast', '.rc-grid', '.rc-label']) {
      expect(await chart.locator(sel).first().evaluate((e) => getComputedStyle(e).animationName), sel).toBe('none')
    }
    await applied(page, SHOWCASE.kanban)
    const board = page.getByTestId('deals-kanban')
    await expect(board.getByTestId('column-total')).toHaveText(['$72,000', '$84,500', '$143,000', '$111,500'])
    expect(await board.locator('.kb-card').first().evaluate((e) => getComputedStyle(e).animationName)).toBe('none')
    await applied(page, SHOWCASE.pivot)
    await expect(page.getByTestId('pivot-grand-total')).toContainText('$411,000')
    expect(await page.locator('.pv-row td').first().evaluate((e) => getComputedStyle(e).animationName)).toBe('none')
    await applied(page, SHOWCASE.heatmap)
    expect(await page.locator('.hm-cell').first().evaluate((e) => getComputedStyle(e).animationName)).toBe('none')
  })
})
