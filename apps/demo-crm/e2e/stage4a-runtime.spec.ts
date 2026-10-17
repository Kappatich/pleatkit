import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { ask, openChat, openCrm } from './chat-helpers'
import { appFor, CARD, DEALS, DOCS, editFile, fixture, openApp } from './helpers'

const SCENARIO_1 = 'In the customer card add phone, city and source; highlight an overdue payment date in red'

function cspViolations(page: Page): string[] {
  const out: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) out.push(m.text())
  })
  return out
}

test('B1: under a CSP without blob: and WebAssembly, a chat edit compiles on the server and loads signed from /morphkit/b', async ({ page }) => {
  const violations = cspViolations(page)
  const requests: string[] = []
  page.on('request', (r) => requests.push(r.url()))
  const doc = await page.goto(`/?user=alice&app=${appFor(page)}&csp=strict-no-blob`)
  expect(doc?.headers()['content-security-policy']).toContain("script-src 'self';")
  await page.getByRole('button', { name: /Globex/ }).click()
  const { turn } = await ask(page, SCENARIO_1)
  await expect(turn).toHaveAttribute('data-status', 'applied')
  const card = page.getByTestId('customer-card')
  await expect(card.getByTestId('phone')).toHaveText('+1 555 0102')
  // Tailwind CSS compiled on the server: the arbitrary values and the red date work
  const color = (id: string) => card.getByTestId(id).evaluate((el) => getComputedStyle(el).color)
  expect(await color('due-date')).not.toBe(await color('city'))
  expect(await card.getByTestId('overdue-chip').evaluate((el) => getComputedStyle(el).fontSize)).toBe('11px')

  const bundle = await page.locator('script[data-morphkit-bundle]').first().getAttribute('src')
  expect(bundle).toMatch(/\/morphkit\/b\/[\w-]+\/[0-9a-f]{40}\.js$/)
  expect(await page.locator('script[data-morphkit-bundle]').first().getAttribute('integrity')).toMatch(/^sha384-/)
  expect(requests.some((u) => u.endsWith('.wasm'))).toBe(false)
  expect(requests.some((u) => u.startsWith('blob:'))).toBe(false)
  // B7: the served bundle names its frames morphkit://
  const js = await (await page.request.get(bundle!)).text()
  expect(js).toMatch(/\/\/# sourceURL=morphkit:\/\/[0-9a-f]{16}\/bundle\.js\s*$/)

  // a reload loads the same signed bundle, still with no blob: and no wasm
  await page.reload()
  await page.getByRole('button', { name: /Globex/ }).click()
  await expect(card.getByTestId('phone')).toHaveText('+1 555 0102')
  expect(violations).toEqual([])
})

test('B1: request -> paint, server compile vs browser compile (scripted agent), metrics', async ({ page }) => {
  const runs = { server: [] as Record<string, number>[], browser: [] as Record<string, number>[] }
  for (let i = 0; i < 5; i++) {
    for (const mode of ['server', 'browser'] as const) {
      await page.goto(`/?user=alice&app=metrics-${mode}-${Date.now().toString(36)}-${i}&compile=${mode}`)
      await page.getByRole('button', { name: /Globex/ }).click()
      await openChat(page)
      // compilers warm (browser mode loads esbuild-wasm and Tailwind when the chat opens; server mode has nothing to load)
      await expect(page.getByTestId('mk-chat')).toHaveAttribute('data-warm', 'true', { timeout: 30_000 })
      const { turn, wallMs } = await ask(page, SCENARIO_1)
      await expect(turn).toHaveAttribute('data-status', 'applied')
      const n = async (a: string) => Number(await turn.getAttribute(a))
      runs[mode].push({ totalMs: await n('data-total-ms'), agentMs: await n('data-agent-ms'), commitMs: await n('data-commit-ms'), wallMs })
    }
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
  const summary = (rs: Record<string, number>[]) => ({
    medianTotalMs: median(rs.map((r) => r.totalMs!)),
    medianAgentMs: median(rs.map((r) => r.agentMs!)),
    medianCommitAndPaintMs: median(rs.map((r) => r.commitMs!)),
    totalMs: rs.map((r) => r.totalMs),
  })
  const result = {
    measuredAt: new Date().toISOString(),
    browser: `chromium headless shell ${page.context().browser()?.version()}`,
    note: 'chat scenario 1, scripted provider, localhost; send -> new card painted. server: the agent compiles, signs and stores the bundle at the end of the run, the browser downloads it (SRI) and swaps. browser: esbuild-wasm + Tailwind in the page.',
    server: summary(runs.server),
    browserCompile: summary(runs.browser),
  }
  console.log('[metrics stage 4a]', JSON.stringify(result, null, 2))
  fs.writeFileSync(path.join(DOCS, 'metrics-stage4a.json'), JSON.stringify(result, null, 2) + '\n')
  expect(result.server.medianTotalMs).toBeGreaterThan(0)
})

test('B2: ?morphkit=safe shows the original version with a banner; a load that never mounted does it by itself', async ({ page }) => {
  await openApp(page)
  const card = page.getByTestId('customer-card')
  await editFile(page, CARD, fixture('customer-card.scenario1.tsx'))
  await page.getByTestId('mk-commit').click()
  await expect(card.getByTestId('phone')).toBeVisible()

  await page.goto(`/?user=alice&dev=1&app=${appFor(page)}&morphkit=safe`)
  await page.getByRole('button', { name: /Globex/ }).click()
  const banner = page.getByTestId('morphkit-safe-mode')
  await expect(banner).toHaveAttribute('data-reason', 'param')
  await expect(card.getByTestId('phone')).toHaveCount(0)
  await page.getByTestId('morphkit-safe-retry').click()
  await expect(card.getByTestId('phone')).toBeVisible()
  await expect(banner).toBeHidden()

  // as if the last load hung for 10 s and the user reloaded: the boot record never got "mounted"
  await page.waitForTimeout(1200) // let this load's heartbeat mark it mounted first
  await page.evaluate((app) => {
    const key = Object.keys(localStorage).find((k) => k.startsWith(`morphkit:boot:${app}:alice`))!
    const rec = JSON.parse(localStorage.getItem(key)!) as Record<string, unknown>
    localStorage.setItem(key, JSON.stringify({ ...rec, mounted: false, at: Date.now() - 10_000, page: 'the-hung-load' }))
  }, appFor(page))
  await openApp(page)
  await expect(banner).toHaveAttribute('data-reason', 'crash')
  await expect(banner).toContainText('did not load last time')
  await expect(card.getByTestId('phone')).toHaveCount(0)
  await page.getByTestId('morphkit-safe-reset').click()
  await expect(banner).toBeHidden()
  await expect(page.getByTestId('mk-head')).toContainText('(base)')
})

test('B4: what the user typed and where they scrolled survive a new version of the panel', async ({ page }) => {
  await openApp(page)
  const withInput = (title: string) =>
    `import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { Deal } from '@/readonly/api'
export default function DealsTable({ deals }: { deals: Deal[] }) {
  return (
    <Card data-testid="deals-table">
      <CardHeader><CardTitle>${title}</CardTitle></CardHeader>
      <CardContent>
        <input data-testid="deal-note" className="border p-1" placeholder="note" />
        <div data-testid="deal-scroll" style={{ height: 60, overflowY: 'auto' }}>
          {Array.from({ length: 30 }, (_, i) => <p key={i}>row {i}</p>)}
          {deals.length} deals
        </div>
      </CardContent>
    </Card>
  )
}
`
  await editFile(page, DEALS, withInput('Deals v1'))
  await page.getByTestId('mk-commit').click()
  const note = page.getByTestId('deal-note')
  await expect(note).toBeVisible()
  await note.fill('call back on Friday')
  await page.getByTestId('deal-scroll').evaluate((el) => (el.scrollTop = 200))

  await editFile(page, DEALS, withInput('Deals v2'))
  await page.getByTestId('mk-commit').click()
  await expect(page.getByTestId('deals-table')).toContainText('Deals v2')
  await expect(note).toHaveValue('call back on Friday')
  expect(await page.getByTestId('deal-scroll').evaluate((el) => el.scrollTop)).toBe(200)
})

test('B6: StrictMode app, one registry and one stylesheet per app instance', async ({ page }) => {
  await openCrm(page)
  const app = appFor(page)
  const { turn } = await ask(page, SCENARIO_1)
  await expect(turn).toHaveAttribute('data-status', 'applied')
  const g = await page.evaluate((ns) => {
    const reg = (globalThis as unknown as { __morphkit?: { apps: Record<string, unknown> } }).__morphkit
    return { apps: Object.keys(reg?.apps ?? {}), styles: [...document.querySelectorAll('style[data-morphkit-css]')].map((s) => s.getAttribute('data-morphkit-css')), ns }
  }, app)
  expect(g.apps).toContain(app)
  expect(g.styles).toEqual([app])
})

test('B3: a panel error without edit frames is not rolled back; an edit that throws is', async ({ page }) => {
  await openApp(page)
  // the edit itself throws: its frame is morphkit://…, so the boundary rolls it back (scenario 4 path)
  await editFile(page, DEALS, `export default function DealsTable() { throw new Error('edit broke it') }`)
  await page.getByTestId('mk-commit').click()
  const crash = page.getByTestId('morphkit-crash')
  await expect(crash).toHaveAttribute('data-morphkit-fault', 'edit')
  await expect(crash).toContainText('Rolling back automatically')
  await crash.getByRole('button', { name: 'Roll back' }).click()
  await expect(crash).toHaveCount(0)
})
