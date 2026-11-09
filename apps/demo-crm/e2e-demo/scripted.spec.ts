import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { ask, base, dataDir, eventsOf, openChat, openDemo, readEvents, SHOWCASE, visitorHash } from './demo-helpers'

// The public demo in SCRIPTED mode (the default): six recorded requests, a friendly refusal for anything else,
// one sandbox per visitor cookie, the research log.

test('the strip, the links and the six requests as chips (the four showcase requests among them)', async ({ page }) => {
  await openDemo(page, 'scripted')
  const strip = page.getByTestId('demo-strip')
  await expect(strip).toContainText('Public demo. Six example requests work; live requests:')
  await expect(page.getByTestId('demo-live-left')).toHaveText('off in this demo')
  await expect(strip.getByRole('link', { name: 'pleatkit.com' })).toHaveAttribute('href', 'https://pleatkit.com')
  await expect(page.getByTestId('demo-admin-link')).toHaveAttribute('href', '/admin')
  await openChat(page)
  const chips = page.locator('.mk-chip')
  await expect(chips).toHaveText(Object.values(SHOWCASE))
  await expect(page.getByTestId('demo-privacy')).toContainText("Requests in this demo are recorded to improve pleatkit; don't paste private data")

  // security headers on the page; no token endpoint; the manifest is not served
  const res = await page.request.get(`${base('scripted')}/`)
  expect(res.headers()['content-security-policy']).toContain("connect-src 'self'")
  expect(res.headers()['content-security-policy']).toContain("frame-ancestors 'none'")
  expect(res.headers()['x-frame-options']).toBe('DENY')
  expect((await page.request.get(`${base('scripted')}/api/pleatkit-token?user=alice&role=admin`)).status()).toBe(404)
  expect((await page.request.get(`${base('scripted')}/pleatkit.manifest.json`)).status()).toBe(404)
  // request size limits
  const big = await page.request.post(`${base('scripted')}/demo/api/event`, { data: { type: 'film_click', pad: 'x'.repeat(100_000) } })
  expect(big.status()).toBe(413)
})

test('a crawler gets robots.txt and the page, but no sandbox, no cookie and no line in the log', async ({ playwright }) => {
  // a crawler keeps no cookie: before this, every page it fetched was a new visitor with a new sandbox
  const bot = await playwright.request.newContext({
    baseURL: base('scripted'),
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.com/gptbot)',
  })
  const robots = await bot.get('/robots.txt')
  expect(robots.status()).toBe(200)
  expect(robots.headers()['content-type']).toContain('text/plain')
  const rules = await robots.text()
  for (const p of ['/admin', '/api/', '/demo/api/', '/pleatkit-store/', '/agent/']) expect(rules).toContain(`Disallow: ${p}`)
  expect(rules).not.toMatch(/^Disallow: \/$/m)

  const health = async () => (await (await bot.get('/demo/api/health')).json()) as { visitors: number }
  const before = { visitors: (await health()).visitors, events: readEvents('scripted').length }
  for (const p of ['/', '/admin', '/admin?app=v0000000000000000&view=audit']) {
    const res = await bot.get(p)
    expect(res.status()).toBe(200)
    expect(await res.text()).toContain('<div id="root">')
    expect(res.headers()['set-cookie']).toBeUndefined()
    expect(res.headers()['x-robots-tag']).toBe(p === '/' ? undefined : 'noindex, nofollow')
  }
  expect((await bot.get('/demo/api/status')).status()).toBe(403)
  expect((await health()).visitors).toBe(before.visitors)
  expect(readEvents('scripted').length).toBe(before.events)
  await bot.dispose()
})

test('free text gets the friendly refusal with the contact, and is logged as refused_out_of_scope', async ({ page, context }) => {
  await openDemo(page, 'scripted')
  const text = 'Make the whole page purple and add a chat with my sales team'
  const turn = await ask(page, text)
  await expect(turn).toHaveAttribute('data-status', 'refused')
  await expect(turn.getByTestId('mk-chat-summary')).toContainText('This public demo answers the six example requests')
  await expect(turn.getByTestId('mk-chat-summary')).toContainText('pilot@pleatkit.com')
  // nothing changed
  await expect(page.getByTestId('customer-card').getByTestId('phone')).toHaveCount(0)
  await expect
    .poll(async () => (await eventsOf('scripted', context, 'request')).map((e) => [e.request, e.outcome, e.mode, e.chip, e.costUsd]))
    .toEqual([[text, 'refused_out_of_scope', 'scripted', false, 0]])

  // the same text again is a repeat; a reworded one within 90 s is a rephrase
  await ask(page, text)
  await ask(page, 'Make the whole page purple and add a chat with the sales team please')
  await expect.poll(async () => (await eventsOf('scripted', context, 'session')).map((e) => e.event)).toEqual(['repeat', 'rephrase'])
})

test('a chip is applied from its recording, undone from the drawer; the log has the run, the feedback and the undo', async ({ page, context }) => {
  await openDemo(page, 'scripted')
  const card = page.getByTestId('customer-card')
  const turn = await ask(page, SHOWCASE.cardFields)
  await expect(turn).toHaveAttribute('data-status', 'applied')
  await expect(card.getByTestId('phone')).toHaveText('+1 555 0102')

  // the feedback strip, docked to the drawer, for this request
  const feedback = page.getByTestId('demo-feedback')
  await expect(feedback).toContainText('Did it do what you asked?')
  const requestId = await feedback.getAttribute('data-request-id')
  expect(requestId).toBeTruthy()
  await page.getByTestId('demo-feedback-yes').click()
  await expect(page.getByTestId('demo-feedback-thanks')).toBeVisible()

  await page.getByTestId('mk-chat-undo').click()
  await expect(card.getByTestId('phone')).toHaveCount(0)

  await expect.poll(async () => (await eventsOf('scripted', context, 'feedback')).map((e) => [e.requestId, e.answer])).toEqual([[requestId, 'yes']])
  await expect.poll(async () => (await eventsOf('scripted', context, 'session')).filter((e) => e.event === 'undo').map((e) => [e.requestId, e.within2min])).toEqual([[requestId, true]])
  const [run] = await eventsOf('scripted', context, 'request')
  expect(run).toMatchObject({ requestId, outcome: 'applied', mode: 'scripted', chip: true, chipId: 'card-fields', costUsd: 0, verdict: 'ok', seq: 1 })
  expect((run!.files as { count: number; bytes: number }).bytes).toBeGreaterThan(500)
  expect(run!.panels).toEqual(['src/dynamic/customer-card.tsx'])
  expect(Number(run!.steps)).toBeGreaterThan(3)
  expect((run!.latencyMs as { total: number }).total).toBeGreaterThan(0)
  expect(run!.answer).toContain('overdue payment date')
  // no IP address anywhere in the log
  expect(JSON.stringify(readEvents('scripted'))).not.toMatch(/127\.0\.0\.1|::1|::ffff/)
})

test('two visitor cookies are two sandboxes: edits, data, bundles and the admin view stay with their visitor', async ({ browser }) => {
  const a = await browser.newContext()
  const b = await browser.newContext()
  const pa = await a.newPage()
  const pb = await b.newPage()
  await openDemo(pa, 'scripted')
  await openDemo(pb, 'scripted')
  expect(await visitorHash(a)).not.toBe(await visitorHash(b))

  await expect(await ask(pa, SHOWCASE.kanban)).toHaveAttribute('data-status', 'applied')
  await expect(pa.getByTestId('deals-kanban')).toBeVisible()
  await pb.reload()
  await pb.getByRole('button', { name: /Globex/ }).click()
  await expect(pb.getByTestId('deals-table')).toBeVisible()
  await expect(pb.getByTestId('deals-kanban')).toHaveCount(0)

  // A's data change is not B's
  const patched = await pa.request.patch(`${base('scripted')}/api/customers/c1/meta`, { data: { phone: '+1 000 visitor A' } })
  expect(patched.ok()).toBe(true)
  const bCustomer = (await (await pb.request.get(`${base('scripted')}/api/customers/c1`)).json()) as { meta: { phone: string } }
  expect(bCustomer.meta.phone).toBe('+1 555 0102')

  // B asks for A's namespace by header: the gateway ignores it
  const aApp = `v${await visitorHash(a)}`
  const spoof = await pb.request.get(`${base('scripted')}/pleatkit-store/v1/admin/requests`, { headers: { 'x-pleatkit-app': aApp, 'x-pleatkit-admin': '1' } })
  expect(spoof.ok()).toBe(true)
  expect(JSON.stringify(await spoof.json())).not.toContain('kanban')

  // A's bundle, fetched by B under A's app id, resolves into B's namespace: not found
  const bundleUrl = await pa.evaluate(() => [...document.querySelectorAll('script[src*="/pleatkit/b/"]')].map((s) => (s as HTMLScriptElement).src)[0] ?? performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('/pleatkit/b/')) ?? null)
  expect(bundleUrl).toBeTruthy()
  expect((await pa.request.get(bundleUrl!)).status()).toBe(200)
  expect((await pb.request.get(bundleUrl!.replace(/\/pleatkit\/b\/[^/]+\//, `/pleatkit/b/${aApp}/`))).status()).toBe(404)

  // the admin view: each visitor sees only their own requests
  await expect(await ask(pb, SHOWCASE.pivot)).toHaveAttribute('data-status', 'applied')
  await pa.goto(`${base('scripted')}/admin`)
  await expect(pa.getByTestId('demo-strip')).toBeVisible()
  await expect(pa.getByTestId('admin-row')).toHaveCount(1)
  await expect(pa.getByTestId('admin-row').first()).toContainText('kanban')
  await pb.goto(`${base('scripted')}/admin`)
  await expect(pb.getByTestId('admin-row')).toHaveCount(1)
  await expect(pb.getByTestId('admin-row').first()).toContainText('pivot')
  await expect.poll(async () => (await eventsOf('scripted', b, 'session')).map((e) => e.event)).toContain('admin_opened')
  await a.close()
  await b.close()
})

test('the pilot form writes a lead; the film link is logged', async ({ page, context }) => {
  await openDemo(page, 'scripted')
  await page.getByTestId('demo-lead-email').fill('not-an-email')
  await page.getByTestId('demo-lead-email').fill('ceo@example.com')
  await page.getByTestId('demo-lead-note').fill('B2B invoicing app')
  await page.getByTestId('demo-lead-send').click()
  await expect(page.getByTestId('demo-lead-done')).toBeVisible()
  const popup = page.waitForEvent('popup')
  await page.getByTestId('demo-film-link').click()
  await (await popup).close()
  await expect.poll(async () => (await eventsOf('scripted', context, 'session')).map((e) => e.event).sort()).toEqual(['email_left', 'film_click'])
  const leads = fs.readFileSync(path.join(dataDir('scripted'), 'leads.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
  expect(leads.at(-1)).toMatchObject({ email: 'ceo@example.com', note: 'B2B invoicing app', visitor: await visitorHash(context) })
})
