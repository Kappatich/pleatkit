import fs from 'node:fs'
import path from 'node:path'
import { expect, type Locator, type Page } from '@playwright/test'
import { appFor, DOCS } from './helpers'

export async function openCrm(page: Page, options: { user?: 'alice' | 'bob'; customer?: string; query?: string } = {}): Promise<void> {
  const { user = 'alice', customer = 'Globex', query = '' } = options
  await page.goto(`/?user=${user}&app=${appFor(page)}${query}`)
  await page.getByRole('button', { name: new RegExp(customer) }).click()
  await expect(page.getByTestId('customer-card')).toContainText(customer)
}

export async function openChat(page: Page): Promise<void> {
  if (await page.getByTestId('mk-chat').isVisible()) return
  await page.getByTestId('mk-chat-open').click()
  await expect(page.getByTestId('mk-chat')).toBeVisible()
}

/** Send a request through the chat and wait until the agent's answer is applied (or not). */
export async function ask(page: Page, text: string): Promise<{ turn: Locator; wallMs: number }> {
  await openChat(page)
  const turns = page.getByTestId('mk-chat-turn')
  const before = await turns.count()
  const input = page.getByTestId('mk-chat-input')
  await input.fill(text)
  const started = Date.now()
  await page.getByTestId('mk-chat-send').click()
  const turn = turns.nth(before)
  await expect(turn).not.toHaveAttribute('data-status', 'running', { timeout: 30_000 })
  return { turn, wallMs: Date.now() - started }
}

export function adminUrl(page: Page): string {
  return `/admin?app=${appFor(page)}`
}

const METRICS = path.join(DOCS, 'metrics-stage2.json')

/** Merge numbers into docs/metrics-stage2.json (one key per scenario). */
export function recordMetrics(key: string, value: unknown): void {
  let all: Record<string, unknown> = {}
  try {
    all = JSON.parse(fs.readFileSync(METRICS, 'utf8')) as Record<string, unknown>
  } catch {
    // first write
  }
  all[key] = value
  all.measuredAt = new Date().toISOString()
  fs.writeFileSync(METRICS, JSON.stringify(all, null, 2) + '\n')
}
