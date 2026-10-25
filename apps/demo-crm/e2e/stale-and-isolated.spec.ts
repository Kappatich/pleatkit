import { expect, test, type Page } from '@playwright/test'
import { openCrm } from './chat-helpers'
import { appFor, CARD, fixture, shot } from './helpers'

interface Manifest {
  dynamic: { path: string; source: string }[]
}

/**
 * Pretend alice customized the card on the previous release of the app: her snapshots were made against a
 * base whose deals table (and, unless `cardUnchanged`, the card she changed) differed, so their baseHash is
 * not today's.
 */
async function seedStaleHead(page: Page, options: { cardUnchanged?: boolean } = {}): Promise<void> {
  const manifest = (await (await page.request.get('/pleatkit.manifest.json')).json()) as Manifest
  const oldBase = Object.fromEntries(manifest.dynamic.map((f) => [f.path, f.source]))
  oldBase['src/dynamic/deals-table.tsx'] += '\n// previous release\n'
  if (!options.cardUnchanged) oldBase[CARD] += '\n// previous release\n'
  const headers = { 'x-pleatkit-user': 'alice', 'x-pleatkit-app': appFor(page) }
  const put = async (id: string, parentId: string | null, files: Record<string, string>, message: string) => {
    const res = await page.request.put(`/pleatkit-store/snapshots/${id}`, {
      headers,
      data: { id, parentId, userId: 'alice', files, message, author: parentId ? 'agent' : 'base', createdAt: new Date().toISOString(), status: 'applied', baseHash: 'previous-release' },
    })
    expect(res.status()).toBe(204)
  }
  await put('01OLDBASE00000000000000000', null, oldBase, 'Original version')
  await put('01OLDEDIT00000000000000000', '01OLDBASE00000000000000000', { ...oldBase, [CARD]: fixture('customer-card.scenario1.tsx') }, 'Add phone, city, source')
  expect((await page.request.post('/pleatkit-store/snapshots/01OLDEDIT00000000000000000/head', { headers })).status()).toBe(204)
}

test('B5: a release that changed only other files carries the edits over by itself, no banner', async ({ page }) => {
  await page.goto(`/?app=${appFor(page)}`)
  await seedStaleHead(page, { cardUnchanged: true })
  await openCrm(page)
  await expect(page.getByTestId('customer-card').getByTestId('phone')).toHaveText('+1 555 0102')
  await expect(page.getByTestId('mk-stale')).toBeHidden()
  // the carried-over version is a new snapshot on today's base; undo goes back to the old one
  await page.getByTestId('mk-chat-open').click()
  await page.getByTestId('mk-chat-history').click()
  await expect(page.getByTestId('mk-history')).toContainText('Carried over to the new version of the app')
})

test('stale snapshot after a release: banner, and the agent carries the edits over to the new base', async ({ page }) => {
  await page.goto(`/?app=${appFor(page)}`)
  await seedStaleHead(page)
  await openCrm(page)
  const banner = page.getByTestId('mk-stale')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('The app was updated')
  // only the panel both sides changed is marked (V1 B5)
  await expect(page.locator('[data-pleatkit-id="customer-card"]')).toHaveAttribute('data-pleatkit-stale', '')
  await expect(page.locator('[data-pleatkit-id="deals-table"]')).not.toHaveAttribute('data-pleatkit-stale', '')
  // her version still renders meanwhile
  await expect(page.getByTestId('customer-card').getByTestId('phone')).toHaveText('+1 555 0102')
  await shot(page, '11-stale-banner.png')

  await page.getByTestId('mk-stale-migrate').click()
  const turn = page.getByTestId('mk-chat-turn').first()
  await expect(turn).toHaveAttribute('data-status', 'applied')
  await expect(banner).toBeHidden()
  await expect(page.getByTestId('customer-card').getByTestId('phone')).toHaveText('+1 555 0102')
  // the migrated snapshot is made against today's base: no banner after a reload either
  await openCrm(page)
  await expect(page.getByTestId('customer-card').getByTestId('phone')).toHaveText('+1 555 0102')
  await expect(banner).toBeHidden()
})

test('stale snapshot: "Reset my changes" starts from the new version', async ({ page }) => {
  await page.goto(`/?app=${appFor(page)}`)
  await seedStaleHead(page)
  await openCrm(page)
  await expect(page.getByTestId('mk-stale')).toBeVisible()
  await page.getByTestId('mk-stale-reset').click()
  await expect(page.getByTestId('mk-stale')).toBeHidden()
  await expect(page.getByTestId('customer-card').getByTestId('phone')).toHaveCount(0)
})

test('isolated panel: the dashboard renders in a sandboxed iframe and still follows commits', async ({ page }) => {
  await openCrm(page, { query: '&isolated=1' })
  const iframe = page.getByTestId('pleatkit-isolated-dashboard-panels')
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
  const frame = page.frameLocator('[data-testid="pleatkit-isolated-dashboard-panels"]')
  await expect(frame.getByTestId('dashboard-panels')).toContainText('Open pipeline')
  await expect(frame.getByTestId('dashboard-panels')).toContainText('$411,000')
  // opaque origin: the page cannot reach into the frame, and the frame cannot reach the page
  expect(await iframe.evaluate((el: HTMLIFrameElement) => el.contentDocument)).toBeNull()
  const height = await iframe.evaluate((el) => el.getBoundingClientRect().height)
  expect(height).toBeGreaterThan(80)

  // a committed edit reaches the frame: the dev panel rewrites the panel, the iframe re-renders it
  await page.goto(`/?user=alice&app=${appFor(page)}&isolated=1&dev=1`)
  await page.getByTestId('mk-file').selectOption('src/dynamic/dashboard-panels.tsx')
  const source = page.getByTestId('mk-source')
  await source.fill((await source.inputValue()).replace("label: 'Open pipeline'", "label: 'Pipeline (isolated edit)'"))
  await page.getByTestId('mk-commit').click()
  await expect(page.getByTestId('mk-status')).toContainText('Committed')
  await expect(frame.getByTestId('dashboard-panels')).toContainText('Pipeline (isolated edit)')
  await shot(page, '12-isolated-panel.png')
})
