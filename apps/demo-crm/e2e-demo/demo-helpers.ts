import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test'

export const PORTS = { scripted: 4191, live: 4192 } as const
export type Mode = keyof typeof PORTS

export const base = (mode: Mode) => `http://127.0.0.1:${PORTS[mode]}`

/** The data folder of a demo server of this run (playwright.demo.config.ts). */
export function dataDir(mode: Mode): string {
  return path.join(os.tmpdir(), 'pleatkit-demo-e2e', process.env.DEMO_E2E_RUN ?? '', mode, 'data')
}

export type EventRecord = Record<string, unknown> & { kind: string; visitor?: string }

/** Every record of the research log (all days of this run). */
export function readEvents(mode: Mode): EventRecord[] {
  const dir = dataDir(mode)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => /^events-.*\.jsonl$/.test(f))
    .flatMap((f) =>
      fs
        .readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as EventRecord),
    )
}

/** The log id of the visitor of this browser context (sha256 of the cookie, as the server writes it). */
export async function visitorHash(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies()).find((c) => c.name === 'pk_demo')
  if (!cookie) throw new Error('no demo cookie')
  return createHash('sha256').update(cookie.value).digest('hex').slice(0, 16)
}

export async function eventsOf(mode: Mode, context: BrowserContext, kind?: string): Promise<EventRecord[]> {
  const v = await visitorHash(context)
  return readEvents(mode).filter((e) => e.visitor === v && (!kind || e.kind === kind))
}

/** Mark the first-visit onboarding as seen in this browser context (the tests that are not about it). */
export async function skipOnboarding(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    try {
      localStorage.setItem('pk_demo_onboarded', '1')
    } catch {
      /* about:blank */
    }
  })
}

export async function openDemo(page: Page, mode: Mode, { onboarding = false }: { onboarding?: boolean } = {}): Promise<void> {
  // nothing leaves the machine: the film and the site links are answered locally
  await page.context().route(/^https:\/\/pleatkit\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>pleatkit.com</p>' }))
  if (!onboarding) await skipOnboarding(page.context())
  await page.goto(`${base(mode)}/`)
  await expect(page.getByTestId('demo-strip')).toBeVisible()
  await page.getByRole('button', { name: /Globex/ }).click()
  await expect(page.getByTestId('customer-card')).toContainText('Globex')
}

export async function openChat(page: Page): Promise<void> {
  if (await page.getByTestId('mk-chat').isVisible()) return
  await page.getByTestId('mk-chat-open').click()
  await expect(page.getByTestId('mk-chat')).toBeVisible()
}

/** Send a request through the drawer and wait for its answer. */
export async function ask(page: Page, text: string): Promise<Locator> {
  await openChat(page)
  const turns = page.getByTestId('mk-chat-turn')
  const before = await turns.count()
  await page.getByTestId('mk-chat-input').fill(text)
  await page.getByTestId('mk-chat-send').click()
  const turn = turns.nth(before)
  await expect(turn).not.toHaveAttribute('data-status', 'running', { timeout: 30_000 })
  return turn
}

export const SHOWCASE = {
  cardFields: 'In the customer card add phone, city and source; highlight an overdue payment date in red',
  discount: 'Add a discount field to deals and recalculate the amount on the server',
  chart: 'Turn the deals table into a monthly revenue chart with a three-month forecast and mark the best month',
  heatmap: 'Show customer retention by signup cohort as a heatmap',
  kanban: 'Show open deals as a kanban board by stage',
  pivot: 'Summarise pipeline by region and owner as a pivot table with totals',
}
