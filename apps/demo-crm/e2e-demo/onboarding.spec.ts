import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { base, skipOnboarding } from './demo-helpers'

// The first-visit onboarding of the public demo (src/core/DemoOnboarding.tsx): the dim layer with a hole around the
// drawer's launcher, the card next to it, the hint next to the drawer, the launcher's pulse until one request is
// applied, and "Start the tour" in the strip.

const url = (query = '') => `${base('scripted')}/${query}`
const card = (page: Page) => page.getByTestId('demo-onboarding-card')
const layer = (page: Page) => page.getByTestId('demo-onboarding')

async function expectNoOnboarding(page: Page): Promise<void> {
  await expect(page.getByTestId('mk-chat-open')).toBeVisible()
  // longer than the 700 ms delay after the page is interactive
  await page.waitForTimeout(1_500)
  await expect(layer(page)).toHaveCount(0)
  await expect(card(page)).toHaveCount(0)
}

/** The card is on screen, the hole is around the launcher, and the two do not overlap. */
async function expectGeometry(page: Page): Promise<void> {
  const viewport = page.viewportSize()!
  const launcher = (await page.getByTestId('mk-chat-open').boundingBox())!
  const hole = (await page.getByTestId('demo-onboarding-hole').boundingBox())!
  const box = (await card(page).boundingBox())!
  expect(hole.x).toBeLessThanOrEqual(launcher.x)
  expect(hole.y).toBeLessThanOrEqual(launcher.y)
  expect(hole.x + hole.width).toBeGreaterThanOrEqual(launcher.x + launcher.width)
  expect(hole.y + hole.height).toBeGreaterThanOrEqual(launcher.y + launcher.height)
  expect(hole.width - launcher.width).toBeLessThan(24)
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
  const overlaps = box.x < hole.x + hole.width && hole.x < box.x + box.width && box.y < hole.y + hole.height && hole.y < box.y + box.height
  expect(overlaps).toBe(false)
}

test('first visit: the layer and the card; "Open the drawer" opens it; the second visit shows nothing; ?tour=1 again', async ({ page }) => {
  await page.goto(url())
  await expect(card(page)).toBeVisible()
  await expect(layer(page)).toBeVisible()
  await expect(card(page)).toHaveAttribute('role', 'dialog')
  await expect(card(page).getByRole('heading', { name: 'Try it on this screen' })).toBeVisible()
  await expect(card(page)).toContainText('Open the drawer, pick one of six example requests, and watch the panel change. Undo is one click.')
  await expect(page.getByTestId('demo-launcher-pulse')).toHaveClass(/demo-launcher-pulse--strong/)
  await expectGeometry(page)
  // the page under the layer cannot be clicked
  await expect(page.getByRole('button', { name: /Globex/ }).click({ timeout: 1_000 })).rejects.toThrow()

  // keyboard: focus starts on the card (its label and text are read), Tab reaches the buttons and stays inside
  const open = page.getByTestId('demo-onboarding-open')
  const skip = page.getByTestId('demo-onboarding-skip')
  await expect(card(page)).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(open).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(skip).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(open).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(skip).toBeFocused()

  await open.click()
  await expect(page.getByTestId('mk-chat')).toBeVisible()
  await expect(layer(page)).toHaveCount(0)
  await expect(card(page)).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('pk_demo_onboarded'))).toBe('1')

  await page.reload()
  await expectNoOnboarding(page)

  await page.goto(url('?tour=1'))
  await expect(card(page)).toBeVisible()
  await expect(layer(page)).toBeVisible()
})

test('Skip and Escape close the layer and mark the tour done; "Start the tour" in the strip runs it again without a reload', async ({ page }) => {
  await page.goto(url())
  await expect(card(page)).toBeVisible()
  await page.getByTestId('demo-onboarding-skip').click()
  await expect(layer(page)).toHaveCount(0)
  await expect(page.getByTestId('mk-chat')).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('pk_demo_onboarded'))).toBe('1')

  const strip = page.getByTestId('demo-strip')
  await expect(strip.locator('.font-semibold', { hasText: 'Public demo.' })).toBeVisible()
  await page.evaluate(() => ((window as unknown as { __sameDocument: boolean }).__sameDocument = true))
  await page.getByTestId('demo-tour-link').click()
  await expect(card(page)).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(layer(page)).toHaveCount(0)
  await expect(card(page)).toHaveCount(0)

  // with the drawer open, the tour closes it first
  await page.getByTestId('mk-chat-open').click()
  await expect(page.getByTestId('mk-chat')).toBeVisible()
  await page.getByTestId('demo-tour-link').click()
  await expect(card(page)).toBeVisible()
  await expect(page.getByTestId('mk-chat')).toHaveCount(0)
  // the launcher itself, clicked through the hole, also ends the tour
  await page.getByTestId('mk-chat-open').click()
  await expect(page.getByTestId('mk-chat')).toBeVisible()
  await expect(card(page)).toHaveCount(0)
})

test('the hint appears while the composer is empty and goes on the first chip; the pulse stops after a request is applied', async ({ page, context }, testInfo) => {
  await skipOnboarding(context)
  await page.goto(url())
  const pulse = page.locator('.demo-launcher-pulse')
  await expect(pulse).toHaveCount(1)
  await expect(pulse).not.toHaveClass(/--strong/)
  await page.getByTestId('mk-chat-open').click()
  await expect(page.getByTestId('mk-chat')).toBeVisible()

  const hint = page.getByTestId('demo-hint')
  await page.waitForTimeout(2_500)
  await expect(hint).toHaveCount(0)
  await expect(hint).toHaveText('Pick a request on the right, or type your own in live mode.', { timeout: 5_000 })
  await page.screenshot({ path: path.join(process.env.DEMO_SHOTS_DIR ?? testInfo.outputPath(), 'hint-1400x900.png') })
  await page.locator('.mk-chip').first().click()
  await expect(hint).toHaveCount(0)

  await page.getByTestId('mk-chat-send').click()
  const turn = page.getByTestId('mk-chat-turn').first()
  await expect(turn).toHaveAttribute('data-status', 'applied', { timeout: 30_000 })
  await page.getByTestId('mk-chat-close').click()
  await expect(page.getByTestId('mk-chat-open')).toBeVisible()
  await expect(pulse).toHaveCount(0)
  // remembered for the next visit, and the hint does not come back after a chip was used
  await page.reload()
  await expect(page.getByTestId('mk-chat-open')).toBeVisible()
  await page.waitForTimeout(500)
  await expect(pulse).toHaveCount(0)
})

test('reduced motion: no pulse animation, a still ring around the launcher during the tour', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  await page.goto(url())
  await expect(card(page)).toBeVisible()
  const ring = page.getByTestId('demo-launcher-pulse')
  expect(await ring.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
  expect(await card(page).evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
  expect(await ring.evaluate((el) => getComputedStyle(el).boxShadow)).toContain('3px')
  await context.close()
})

for (const [name, viewport] of [
  ['2560x1440', { width: 2560, height: 1440 }],
  ['390x844', { width: 390, height: 844 }],
] as const) {
  test(`the onboarding at ${name}: the card on screen next to the hole; a screenshot for review`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce', ...(viewport.width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) })
    const page = await context.newPage()
    await page.goto(url())
    await expect(card(page)).toBeVisible()
    await expect(card(page)).toHaveAttribute('data-side', viewport.width < 900 ? 'above' : 'left')
    await expectGeometry(page)
    const dir = process.env.DEMO_SHOTS_DIR ?? testInfo.outputPath()
    await page.screenshot({ path: path.join(dir, `onboarding-${name}.png`) })
    await context.close()
  })
}
