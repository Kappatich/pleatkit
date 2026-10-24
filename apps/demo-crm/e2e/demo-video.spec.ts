import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { DOCS } from './helpers'
import { Film, overlay } from './video-helpers'

// The demo film (ARCHITECTURE §8), about 75 s: request → the card changes in place → undo and redo → a backend
// request goes to the admin → the admin view → bob's card is unchanged. Recorded headless with Playwright's
// recordVideo, scripted provider paced by PLEATKIT_SCRIPTED_DELAY_MS; scripts/record-demo.mjs trims it to the
// start/end marks, synthesizes the sound track from docs/.video/events.json and writes docs/demo.mp4.
// The storyboard, beat by beat:
//  1 cold open on the app, motion label "YOUR APP · Acme CRM", visible pointer (26 px, ripple on every click)
//  2 pulse ring on the launcher, click, the drawer slides in, label "PLEATKIT DRAWER"
//  3 typing (34 ms/char, 400 ms after commas), send; every panel but the card blurs while the agent works;
//    applied: un-blur, the card flashes once, hold
//  4 undo, hold; redo by asking again, hold
//  5 the backend request is handed to the admin, hold
//  6 title band "What the admin sees", navigation to /admin behind it
//  7 admin view with its own label, the applied row opens its diff, scroll, hold
//  8 title band "Another customer, same app"
//  9 bob's card is unchanged
// 10 closing card (pleatkit.com · open source · MIT), fade to paper
// Sounds are not recorded: every typed character, click, drawer open, applied, band and close is logged with its
// offset from the page's creation (the video's first frame) and mixed in by record-demo.mjs.
// Never runs in the normal e2e suite.
test.skip(process.env.PLEATKIT_VIDEO !== '1', 'set PLEATKIT_VIDEO=1 (pnpm demo:video) to record the demo')

const SIZE = { width: 1280, height: 800 }
const OUT = path.join(DOCS, '.video')
const CARD = '[data-testid="customer-card"]'

test('demo video (~75 s): request, change, undo, backend request, admin, per-customer versions', async ({ browser }) => {
  test.setTimeout(180_000)
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })
  const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: OUT, size: SIZE }, deviceScaleFactor: 1 })
  await context.addInitScript(overlay)
  const film = await Film.open(context)
  const page = film.page
  const app = `demo-video-${Date.now().toString(36)}`
  const card = page.getByTestId('customer-card')
  const input = page.getByTestId('mk-chat-input')
  const send = page.getByTestId('mk-chat-send')

  // Beat 1 (0–3 s): cold open, drawer closed
  await page.goto(`/?user=alice&app=${app}`)
  await page.getByRole('button', { name: /Globex/ }).dispatchEvent('click')
  await expect(card).toContainText('Globex')
  await expect(page.getByTestId('mk-chat-open')).toBeVisible()
  await page.mouse.move(640, 400)
  await film.pause(300)
  film.mark('start')
  await film.pause(300) // the label draws in on screen, not before the first frame
  await film.label('app', 'YOUR APP', ' · Acme CRM')
  await film.caption('A CRM built with pleatkit.', 'Alice is signed in.')
  await film.pause(1200)
  await film.glide(760, 470, 1300)
  await film.pause(500)

  // Beat 2 (3–8 s): the launcher pulses twice, click, the drawer slides in
  const launcher = page.getByTestId('mk-chat-open')
  await film.glideTo(launcher, 1100)
  await film.pulse(launcher)
  await film.pause(1250)
  await film.click()
  film.sound('drawer')
  await expect(input).toBeVisible()
  await film.pause(250)
  await film.label('drawer', 'PLEATKIT DRAWER')
  await film.caption('Alice asks the agent in plain words.', 'It may only rewrite the panels the developer marked as hers.')
  await film.pause(1600)

  // Beat 3 (8–22 s): the request; everything but the card blurs while the agent works
  await film.glideClick(input, 900)
  await film.pause(250)
  await film.type('In the customer card add phone, city and source; highlight an overdue payment date in red')
  await film.pause(700)
  await film.glideClick(send, 500)
  await film.dim(true)
  await film.glide(640, 420, 900)
  await film.waitStatus(0, 'applied')
  film.sound('applied')
  await film.dim(false)
  await film.flash(CARD)
  await film.caption('Applied: compiled, checked, swapped in without a reload.', 'Phone, city and source appear; the overdue date turns red.')
  await expect(card.getByTestId('phone')).toBeVisible()
  await film.glideTo(card, 900, 0.48, 0.5) // rests just right of the new fields
  await film.pause(3500)

  // Beat 4 (22–34 s): undo, then ask again
  await film.glideClick(page.getByTestId('mk-chat-undo'), 1000)
  await expect(card.getByTestId('phone')).toHaveCount(0)
  await film.caption('Every edit is a version. Undo is one click.')
  await film.glideTo(page.getByTestId('mk-chat-turn').first(), 700, 0.3, 0.75) // off the button: its tooltip goes
  await film.pause(2400)
  await film.caption('Ask again and the edit is back.', 'History keeps every version of her page.')
  await film.glideClick(input, 800)
  await film.type('Show phone, city and source again, overdue date in red')
  await film.pause(500)
  await film.glideClick(send, 500)
  await film.dim(true)
  await film.glide(640, 420, 900)
  await film.waitStatus(1, 'applied')
  film.sound('applied')
  await film.dim(false)
  await film.flash(CARD)
  await expect(card.getByTestId('phone')).toBeVisible()
  await film.pause(2000)

  // Beat 5 (34–44 s): a request that needs the server is handed to the team, nothing changes
  await film.caption('Some requests need the backend.', 'The agent does not fake it: it hands the request to the team.')
  await film.glideClick(input, 800)
  await film.type('Add a discount field to deals and recalculate the amount on the server')
  await film.pause(500)
  await film.glideClick(send, 500)
  await film.waitStatus(2, 'needs-backend')
  await film.glideTo(page.getByTestId('mk-chat-turn').nth(2), 900, 0.35, 0.9)
  await film.pause(3000)

  // Beat 6 (44–46 s): title band; /admin loads behind it
  let band = await film.band('What the admin sees', 'a separate screen, only for your team', { carry: true })
  await film.pause(500)
  await page.goto(`/admin?app=${app}`)
  await expect(page.getByTestId('admin-row')).toHaveCount(3)
  await film.bandOut(band)

  // Beat 7 (46–60 s): the admin view
  await film.pause(250)
  await film.label('admin', 'ADMIN VIEW', 'your team') // two lines: it fits the page's left margin, over nothing
  await film.caption('The admin sees every request: outcome, cost, the diff.', 'An edit can be undone for one user.')
  await film.glide(640, 300, 900)
  await film.pause(2800)
  const edit = page.locator('[data-testid="admin-row"][data-status="applied"]').first()
  await film.glideClick(edit, 900)
  await expect(page.getByTestId('admin-diff').first()).toBeVisible()
  await film.caption('Code and diff stay here, never in the customer\'s chat.')
  await film.pause(1200)
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const from = scrollY
        const t0 = performance.now()
        const step = (now: number) => {
          const p = Math.min(1, (now - t0) / 1200)
          scrollTo(0, from + 260 * (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2))
          if (p < 1) requestAnimationFrame(step)
          else done()
        }
        requestAnimationFrame(step)
      }),
  )
  await film.pause(4000)

  // Beat 8 (60–62 s): title band; bob's page loads behind it
  band = await film.band('Another customer, same app', 'versions are per customer', { carry: true })
  await film.pause(500)
  await page.goto(`/?user=bob&app=${app}`)
  await expect(card).toBeVisible()
  await expect(page.getByTestId('mk-chat-open')).toBeVisible()
  await film.bandOut(band)

  // Beat 9 (62–70 s): bob's card is unchanged
  await film.label('app', 'YOUR APP', ' · Acme CRM')
  await film.pause(900)
  await film.glideClick(page.getByRole('button', { name: /Globex/ }), 1000)
  await expect(card).toContainText('Globex')
  await expect(card.getByTestId('phone')).toHaveCount(0)
  await film.caption('Bob\'s card is unchanged.', 'Each customer gets their own version.')
  await film.glideTo(card, 900, 0.6, 0.62)
  await film.pause(3600)

  // Beat 10 (70–76 s): closing card, fade to paper
  await film.band('pleatkit.com', 'open source · MIT', { mark: true })
  film.sound('close', film.now() + 250)
  await film.pause(3450)
  await film.fade()
  await film.pause(1800)
  film.mark('end')

  const video = page.video()!
  await context.close()
  await video.saveAs(path.join(OUT, 'demo.webm'))
  film.save(path.join(OUT, 'events.json'))
})
