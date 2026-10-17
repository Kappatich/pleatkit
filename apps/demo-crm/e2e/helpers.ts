import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Page } from '@playwright/test'

const here = path.dirname(fileURLToPath(import.meta.url))
export const DOCS = path.resolve(here, '../../../docs')
export const SHOTS = path.join(DOCS, 'screenshots')

export const CARD = 'src/dynamic/customer-card.tsx'
export const DEALS = 'src/dynamic/deals-table.tsx'

export const fixture = (name: string): string => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8')

export async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: true })
}

// Every test page gets its own namespace in the shared store-server, so tests never see each other's edits.
const apps = new WeakMap<Page, string>()
let appSeq = 0
export function appFor(page: Page): string {
  let id = apps.get(page)
  if (!id) apps.set(page, (id = `e2e-${Date.now().toString(36)}-${++appSeq}`))
  return id
}

export async function openApp(page: Page, user: 'alice' | 'bob' = 'alice', customer = 'Globex'): Promise<void> {
  await page.goto(`/?user=${user}&dev=1&app=${appFor(page)}`)
  await page.getByRole('button', { name: new RegExp(customer) }).click()
  await expect(page.getByTestId('customer-card')).toContainText(customer)
  await expect(page.getByTestId('mk-dev-panel')).toBeVisible()
}

export async function editFile(page: Page, file: string, source: string): Promise<void> {
  await page.getByTestId('mk-file').selectOption(file)
  await page.getByTestId('mk-source').fill(source)
}

export interface Metrics {
  initMs: number | null
  wasmBytes: number | null
  wasmFromCache: boolean | null
  esbuildVersion: string | null
  lastCheckMs: number | null
  lastCommitMs: number | null
  lastSwapMs: number | null
}

export async function readMetrics(page: Page): Promise<Metrics> {
  return JSON.parse((await page.getByTestId('mk-metrics').textContent()) ?? '{}') as Metrics
}
