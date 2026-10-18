import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { carryOverRelease, ScriptedProvider } from '@pleatkit/agent'
import { manifestReleaseHash, type PleatkitManifest } from '@pleatkit/runtime/compiler'
import { adminUrl, ask, openCrm } from './chat-helpers'
import { appFor, CARD, fixture, shot as rawShot } from './helpers'

const here = path.dirname(fileURLToPath(import.meta.url))
const SCENARIO_1 = 'In the customer card add phone, city and source; highlight an overdue payment date in red'
const STORE = 'http://localhost:8800'
const admin = (app: string) => ({ 'x-pleatkit-admin': '1', 'x-pleatkit-app': app })

// screenshots of settled screens: no fade-in caught halfway, no hover left on the last button clicked
test.use({ reducedMotion: 'reduce' })
async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(1, 1)
  await rawShot(page, name)
}

/** Requests the panels could not serve, as a pilot week would have them (the wish map's demo data). */
async function seedWishes(request: APIRequestContext, app: string): Promise<void> {
  const rows: [string, string, string, string?][] = [
    ['alice', 'Add a discount field to deals and recalculate the amount on the server', 'needs-backend'],
    ['bob', 'Discount per customer that changes the deal total', 'needs-backend'],
    ['carol', 'Скидка на сделку с пересчётом суммы', 'needs-backend'],
    ['bob', 'Export the deals of a customer to CSV', 'needs-backend', 'deals-table'],
    ['dora', 'Send an e-mail reminder when a payment is overdue', 'partial', 'customer-card'],
    ['alice', 'Put our logo and a new title in the header', 'not-editable'],
    ['carol', 'Sort the customer list on the left by due date', 'not-editable'],
  ]
  for (const [userId, text, verdict, target] of rows) {
    const res = await request.post('/pleatkit-store/v1/requests', {
      headers: { 'x-pleatkit-agent': '1', 'x-pleatkit-user': userId, 'x-pleatkit-app': app },
      data: { userId, text, verdict, status: verdict === 'not-editable' ? 'refused' : 'pending-admin', log: [], ...(target ? { target } : {}) },
    })
    expect(res.status()).toBe(201)
  }
}

test('C9: the wish map is rebuilt by one classifier call and shown per panel', async ({ page }) => {
  await page.goto(`/?app=${appFor(page)}`)
  const app = appFor(page)
  await seedWishes(page.request, app)
  await page.goto(`/admin?view=wishes&app=${app}`)
  await expect(page.getByTestId('admin-nav-wishes')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('admin-wishes')).toContainText('No map yet')
  await page.getByTestId('admin-wishes-rebuild').click()
  const rows = page.getByTestId('admin-wish')
  await expect(rows).toHaveCount(5)
  await expect(page.getByTestId('admin-wishes-stats')).toContainText('7 requests the panels could not serve · 5 themes')
  const discount = rows.filter({ hasText: 'Discounts that change the deal amount' })
  await expect(discount).toHaveAttribute('data-panel', 'deals-table')
  await expect(discount.locator('.adm-big')).toHaveText('3')
  await expect(rows.filter({ hasText: 'Rename and restyle the app header' })).toHaveAttribute('data-kind', 'out-of-zone')
  await shot(page, '16-admin-wishes.png')
})

test('C11: code search finds the live versions with a string; rollback by selection needs the count', async ({ page }) => {
  for (const user of ['alice', 'bob'] as const) {
    await openCrm(page, { user })
    await expect((await ask(page, SCENARIO_1)).turn).toHaveAttribute('data-status', 'applied')
  }
  await page.goto(`${adminUrl(page)}&view=snapshots`)
  await page.getByTestId('admin-grep').fill('daysUntil(customer.dueDate)')
  await page.getByTestId('admin-grep-go').click()
  await expect(page.getByTestId('admin-grep-count')).toContainText('2 live versions contain')
  await expect(page.getByTestId('admin-grep-row')).toHaveCount(2)
  await expect(page.getByTestId('admin-grep-row').first().locator('mark')).toHaveText('daysUntil(customer.dueDate)')
  await page.getByTestId('admin-grep-rollback').click()
  await expect(page.getByTestId('admin-grep-confirm')).toContainText('Each of the 2 users')
  await shot(page, '17-admin-code-search.png')
  await page.getByTestId('admin-grep-confirm-go').click()
  await expect(page.getByTestId('admin-grep-msg')).toHaveText('Rolled back 2: alice, bob')
  await expect(page.getByTestId('admin-grep-count')).toContainText('0 live versions contain')
  // both are back on their original card
  await openCrm(page, { user: 'bob' })
  await expect(page.getByTestId('customer-card').getByTestId('phone')).toHaveCount(0)
  const audit = (await (await page.request.get('/pleatkit-store/v1/admin/audit', { headers: admin(appFor(page)) })).json()) as { rows: { action: string }[] }
  expect(audit.rows.filter((r) => r.action === 'snapshot.rollback-selection')).toHaveLength(2)
})

interface Manifest {
  dynamic: { path: string; source: string }[]
}

/** Users with versions made on the previous release (as in stale-and-isolated.spec.ts). */
async function seedPreviousRelease(page: Page, user: 'alice' | 'bob', cardUnchanged: boolean): Promise<void> {
  const manifest = (await (await page.request.get('/pleatkit.manifest.json')).json()) as Manifest
  const oldBase = Object.fromEntries(manifest.dynamic.map((f) => [f.path, f.source]))
  oldBase['src/dynamic/deals-table.tsx'] += '\n// previous release\n'
  if (!cardUnchanged) oldBase[CARD] += '\n// previous release\n'
  const headers = { 'x-pleatkit-user': user, 'x-pleatkit-app': appFor(page) }
  const put = async (id: string, parentId: string | null, files: Record<string, string>, message: string) => {
    const res = await page.request.put(`/pleatkit-store/v1/snapshots/${id}`, {
      headers,
      data: { id, parentId, userId: user, files, message, author: parentId ? 'agent' : 'base', createdAt: new Date().toISOString(), status: 'applied', baseHash: 'previous-release' },
    })
    expect(res.status()).toBe(204)
  }
  const tag = user.toUpperCase().padEnd(5, '0')
  await put(`01${tag}BASE0000000000000`, null, oldBase, 'Original version')
  await put(`01${tag}EDIT0000000000000`, `01${tag}BASE0000000000000`, { ...oldBase, [CARD]: fixture('customer-card.scenario1.tsx') }, 'Add phone, city, source')
  expect((await page.request.post(`/pleatkit-store/v1/snapshots/01${tag}EDIT0000000000000/head`, { headers })).status()).toBe(204)
}

test('C10: bulk carry-over after a release with a budget, shown per release, and the release rollback', async ({ page }) => {
  await page.goto(`/?app=${appFor(page)}`)
  const app = appFor(page)
  // alice changed the card only (the release did not touch it): no model; bob's card changed on both sides: the agent
  await seedPreviousRelease(page, 'alice', true)
  await seedPreviousRelease(page, 'bob', false)
  const manifest = JSON.parse(fs.readFileSync(path.join(here, '..', 'dist', 'pleatkit.manifest.json'), 'utf8')) as PleatkitManifest
  const release = await manifestReleaseHash(manifest)
  const r = await carryOverRelease({ storeUrl: STORE, appId: app, manifest, release, budgetUsd: 1, provider: new ScriptedProvider(path.join(here, 'fixtures', 'agent')) })
  expect(r.items.map((i) => `${i.userId}:${i.state}`)).toEqual(['alice:carried', 'bob:migrated'])

  // the carried versions are on this release: no "app was updated" banner, the phone is there
  await openCrm(page, { user: 'bob' })
  await expect(page.getByTestId('customer-card').getByTestId('phone')).toHaveText('+1 555 0102')
  await expect(page.getByTestId('mk-stale')).toBeHidden()

  await page.goto(`/admin?view=releases&app=${app}`)
  const run = page.getByTestId('admin-release')
  await expect(run).toHaveAttribute('data-status', 'done')
  await expect(run).toContainText('1 carried · 1 by the agent')
  await run.click()
  await expect(page.getByTestId('admin-release-item')).toHaveCount(2)
  await shot(page, '18-admin-releases.png')
  await page.getByTestId('admin-release-rollback').click()
  await page.getByTestId('admin-release-rollback-go').click()
  await expect(page.getByTestId('admin-release-msg')).toHaveText('Rolled back 2; 0 kept a newer version.')
  await expect(run).toHaveAttribute('data-status', 'rolled-back')

  // bob is back on his version of the previous release: the banner asks again
  await openCrm(page, { user: 'bob' })
  await expect(page.getByTestId('mk-stale')).toBeVisible()
})

test('4a screens: flags, events, audit chain, plan and usage; C8: view as a user, audited', async ({ page }) => {
  await openCrm(page, { user: 'alice' })
  await expect((await ask(page, SCENARIO_1)).turn).toHaveAttribute('data-status', 'applied')
  await openCrm(page, { user: 'bob' })
  await expect((await ask(page, 'Add a discount field to deals and recalculate the amount on the server')).turn).toHaveAttribute('data-status', 'needs-backend')
  const app = appFor(page)

  // view as alice from her request: her version, a banner, no chat; the reads are in the audit chain
  await page.goto(adminUrl(page))
  await page.getByTestId('admin-row').filter({ hasText: 'alice' }).click()
  await page.getByTestId('admin-view-as').click()
  await expect(page.getByTestId('viewing-as')).toContainText('Viewing as alice')
  await page.getByRole('button', { name: /Globex/ }).click()
  await expect(page.getByTestId('customer-card').getByTestId('phone')).toHaveText('+1 555 0102')
  await expect(page.getByTestId('mk-chat-open')).toHaveCount(0)
  await shot(page, '23-view-as.png')

  // flags: freeze bob's new edits from the form
  await page.goto(`/admin?view=flags&app=${app}`)
  await page.getByTestId('admin-flag-id').fill('bob')
  await page.getByTestId('admin-flag-set').click()
  await expect(page.getByTestId('admin-flag')).toHaveCount(1)
  await expect(page.getByTestId('admin-flag')).toContainText('edits.enabled')
  await expect(page.getByTestId('admin-flags-state')).toContainText('pleatkit: on · New edits: on')
  await shot(page, '19-admin-flags.png')
  const flags = (await (await page.request.get(`/pleatkit-store/v1/flags?userId=bob`, { headers: { 'x-pleatkit-agent': '1', 'x-pleatkit-app': app } })).json()) as { flags: Record<string, unknown> }
  expect(flags.flags['edits.enabled']).toBe(false)

  await page.goto(`/admin?view=events&app=${app}`)
  await expect(page.getByTestId('admin-events-stats')).toContainText('2 requested · 1 applied')
  await page.getByTestId('admin-events-type-edit.applied').click()
  await expect(page.getByTestId('admin-event')).toHaveCount(1)
  await page.getByTestId('admin-events-type-all').click()
  await shot(page, '20-admin-events.png')

  await page.goto(`/admin?view=audit&app=${app}`)
  await expect(page.getByTestId('admin-audit-verify')).toHaveAttribute('data-ok', 'true')
  await expect(page.getByTestId('admin-audit-verify')).toContainText('Chain intact')
  const impersonated = page.getByTestId('admin-audit-row').filter({ has: page.locator('.adm-as') })
  await expect(impersonated.first()).toContainText('support:support as alice')
  await expect(page.getByTestId('admin-audit-row').filter({ hasText: 'impersonate.read' }).first()).toBeVisible()
  await shot(page, '21-admin-audit.png')

  await page.goto(`/admin?view=plan&app=${app}`)
  await expect(page.getByTestId('admin-plan-today')).toContainText('Plan: free (default)')
  await expect(page.getByTestId('admin-plan-today')).toContainText('2 of 300 edits')
  await page.getByTestId('admin-plan-appDailyEdits').fill('500')
  await page.getByTestId('admin-plan-save').click()
  await expect(page.getByTestId('admin-plan-msg')).toContainText('Saved')
  const plan = (await (await page.request.get('/pleatkit-store/v1/admin/plan', { headers: admin(app) })).json()) as { limits: Record<string, number> }
  expect(plan.limits.appDailyEdits).toBe(500)
  await shot(page, '22-admin-plan.png')
})

test('C9: GET /v1/report as CSV through the app proxy', async ({ page }) => {
  await openCrm(page, { user: 'alice' })
  await expect((await ask(page, SCENARIO_1)).turn).toHaveAttribute('data-status', 'applied')
  const today = new Date().toISOString().slice(0, 10)
  const res = await page.request.get(`/pleatkit-store/v1/report?from=${today}&to=${today}`, { headers: admin(appFor(page)) })
  expect(res.headers()['content-type']).toContain('text/csv')
  const lines = (await res.text()).trim().split('\r\n')
  expect(lines[0]).toMatch(/^date,org,orgs,users,requests,ok,/)
  expect(lines.at(-1)).toMatch(/^total,all,1,1,1,1,/)
})
