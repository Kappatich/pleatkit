import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { DOCS } from './helpers'
import { Film, overlay, type Rect } from './video-helpers'

// The demo film (ARCHITECTURE §8), about 75 s. Show, don't tell: a camera inside the page zooms on the part that
// matters right now, area plates name the app, the drawer and the admin view once, a thin red frame keeps the name
// while the camera stays there, and everything but the changing panel is blurred while it changes. Recorded
// headless with Playwright's recordVideo, scripted provider paced by PLEATKIT_SCRIPTED_DELAY_MS;
// scripts/record-demo.mjs trims it to the start/end marks, synthesizes the sound track from docs/.video/events.json
// and writes docs/demo.mp4. The shot list:
//  a cold open, plate on the app ("Your app")
//  b camera 1.8x on the launcher, two pulses, click; drawer opens; 1x; plate on the drawer; frame DRAWER
//  c camera 2x on the composer; the request is typed and sent
//  d camera 1.6x on the customer card, the rest blurred; the agent works; the card changes; caption; back to 1x
//  e camera on undo, click, pan to the card as it reverts; caption; 1x
//  f the same for redo, so the customer part ends on the changed card
//  g camera 2x on the composer; a backend request; the drawer's answer; caption
//  h band "What the admin sees"; plate on the request row; frame ADMIN; camera on the row, its diff; caption
//  i closing card (pleatkit.com · open source · MIT), fade to paper
// Five captions in all, counting the closing card. Sounds are not recorded: every typed character, click, camera
// move, plate, drawer open, applied, band and close is logged with its offset from the page's creation (the video's
// first frame) and mixed in by record-demo.mjs.
// Never runs in the normal e2e suite.
test.skip(process.env.PLEATKIT_VIDEO !== '1', 'set PLEATKIT_VIDEO=1 (pnpm demo:video) to record the demo')

const SIZE = { width: 1280, height: 800 }
const OUT = path.join(DOCS, '.video')
const CARD = '[data-testid="customer-card"]'
const DRAWER = '[data-testid="mk-chat"]'
const INPUT = '[data-testid="mk-chat-input"]'
const ROW = '[data-testid="admin-row"][data-status="applied"]'

test('demo video (~75 s): area plates, camera, request, undo, redo, backend request, admin', async ({ browser }) => {
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
  const launcher = page.getByTestId('mk-chat-open')

  // a (0–4 s): cold open; the app area lit, everything else dimmed
  await page.goto(`/?user=alice&app=${app}`)
  await page.getByRole('button', { name: /Globex/ }).dispatchEvent('click')
  await expect(card).toContainText('Globex')
  await expect(launcher).toBeVisible()
  // warm-up before the start mark (cut from the film): the first open of the drawer loads the compiler
  await launcher.click()
  await expect(input).toBeVisible()
  await page.getByTestId('mk-chat-close').click()
  await expect(launcher).toBeVisible()
  await film.pause(1500)
  await film.glide(980, 300, 10)
  await film.pause(300)
  film.mark('start')
  await film.pause(500)
  const appArea: Rect = { x: 72, y: 8, width: 1136, height: 588 }
  await film.plate(appArea, 'Your app', 'as your customers see it', { hold: 1900, side: 'below' })
  await film.pause(500)

  // b (4–13 s): the launcher, the drawer
  await film.camera('[data-testid="mk-chat-open"]', 1.8, 1000)
  await film.glideTo(launcher, 800)
  await film.pulse(launcher)
  await film.pause(1250)
  await film.click()
  film.sound('drawer')
  await expect(input).toBeVisible()
  await film.pause(600)
  await film.camera(null, 1, 900)
  await film.glide(560, 640, 500)
  await film.plate(DRAWER, 'The pleatkit drawer', 'your customer writes what they want changed', { hold: 1900, side: 'left' })
  await film.frame(DRAWER, 'Drawer', 0.74, -4) // the tag between the drawer's title and its buttons
  film.shot('drawer frame', 500)
  await film.pause(1000)

  // c (13–21 s): the composer, the request
  await film.camera(INPUT, 2, 1000)
  await film.glideClick(input, 700, 0.3, 0.5)
  await film.pause(150)
  // the pointer steps aside, off the text about to be typed
  const box = (await input.boundingBox())!
  await film.glide(box.x - 14, box.y + box.height * 0.6, 350)
  film.shot('composer typing', 2600)
  await film.type('In the customer card add phone, city and source; highlight an overdue payment date in red')
  await film.pause(500)
  await film.glideClick(send, 450)
  await film.pause(600)

  // d (21–33 s): the card that is about to change; everything else blurred
  await film.unframe()
  // aimed a little below the card's centre: it grows downwards when the fields appear
  const before = await film.rect(CARD)
  const cardView = { ...before, height: before.height + 110 }
  await film.blur(CARD, 8, 10) // the blur follows the card while the camera moves
  await film.camera(cardView, 1.6, 1100)
  await film.glideTo(card, 600, 0.82, 0.62)
  film.shot('card blur before', 300)
  await film.waitStatus(0, 'applied')
  film.sound('applied')
  await expect(card.getByTestId('phone')).toBeVisible()
  await film.pause(500)
  await film.caption('Applied. Only this panel changed.')
  await film.pause(900)
  film.mark('poster')
  film.shot('card after')
  await film.pause(1300)
  await film.caption('')
  await film.blur(null)
  await film.pause(400)
  await film.camera(null, 1, 1000)
  await film.pause(1500)

  // e (33–40 s): undo
  const undo = page.getByTestId('mk-chat-undo')
  await film.camera('[data-testid="mk-chat-undo"]', 1.6, 1000)
  await film.glideClick(undo, 700)
  film.shot('undo click', 100)
  await film.pause(250)
  await film.camera(cardView, 1.6, 1000)
  await film.glideTo(card, 500, 0.82, 0.62)
  await expect(card.getByTestId('phone')).toHaveCount(0)
  await film.caption('Undo. The old version is back.')
  film.shot('undo caption', 900)
  await film.pause(2200)
  await film.caption('')

  // f (40–46 s): redo, so the customer part ends on the changed card
  const redo = page.getByTestId('mk-chat-redo')
  await expect(redo).toBeVisible()
  await film.camera('[data-testid="mk-chat-redo"]', 1.6, 1000)
  await film.glideClick(redo, 700)
  await film.pause(250)
  await film.camera(cardView, 1.6, 1000)
  await film.glideTo(card, 500, 0.82, 0.62)
  await expect(card.getByTestId('phone')).toBeVisible()
  film.shot('redo card', 300)
  await film.pause(1300)
  await film.camera(null, 1, 1000)
  await film.pause(700)

  // g (46–58 s): a request that needs the server; the drawer says so
  await film.camera(INPUT, 2, 1000)
  await film.glideClick(input, 600, 0.3, 0.5)
  await film.pause(150)
  await film.glide(box.x - 14, box.y + box.height * 0.6, 350)
  await film.type('Add a discount field to deals and recalculate the amount on the server')
  await film.pause(400)
  await film.glideClick(send, 450)
  await film.waitStatus(1, 'needs-backend')
  await film.pause(300)
  await film.camera(page.getByTestId('mk-chat-turn').nth(1), 1.6, 1000)
  await film.caption('Out of scope: the agent asks first.')
  film.shot('request 2 answer', 900)
  await film.pause(2800)
  await film.caption('')

  // h (58–74 s): the admin view
  const band = await film.band('What the admin sees', 'a separate screen, only for your team', { carry: true })
  await film.pause(500)
  await page.goto(`/admin?app=${app}`)
  await expect(page.getByTestId('admin-row')).toHaveCount(2)
  await film.bandOut(band)
  await film.pause(600)
  await film.plate(ROW, 'The admin view', 'every request, its diff, undo for the customer', { hold: 1900, pad: 6, side: 'below' })
  await film.frame(ROW, 'Admin', 0.8, 6) // the tag where the row above has no text
  film.shot('admin frame', 500)
  await film.pause(900)
  // 1.6x on the row: from the request text to the outcome
  const row = page.locator(ROW).first()
  const r = await film.rect(ROW)
  await film.camera({ x: r.x + 160, y: r.y + r.height / 2 - 250, width: 800, height: 500 }, 1.6, 1000)
  await film.glideClick(row, 700, 0.42, 0.5)
  await expect(page.getByTestId('admin-diff').first()).toBeVisible()
  await film.pause(600)
  // the diff, from its top down to the buttons under it (undo for this customer), slowly
  await film.unframe()
  const detail = await film.rect('[data-testid="admin-detail"]')
  const buttons = await film.rect('[data-testid="admin-rollback"]')
  await film.camera({ x: detail.x - 24, y: detail.y - 30, width: 800, height: 500 }, 1.6, 1000)
  await film.caption('Every request, its diff, undo.')
  await film.camera({ x: detail.x - 24, y: buttons.y + buttons.height + 40 - 500, width: 800, height: 500 }, 1.6, 2000)
  await film.glideTo(page.getByTestId('admin-rollback'), 700)
  film.shot('diff zoom', 200)
  await film.pause(1400)
  await film.caption('')
  await film.camera(null, 1, 1000)
  await film.pause(1000)

  // i (74–80 s): closing card, fade to paper
  await film.band('pleatkit.com', 'open source · MIT', {
    mark: true,
    note: 'The agent\'s answers in this film are recorded; compile, commit, undo and storage run for real.',
  })
  film.sound('close', film.now() + 250)
  film.shot('closing', 1800)
  await film.pause(3600)
  await film.fade()
  await film.pause(1600)
  film.mark('end')

  const video = page.video()!
  await context.close()
  await video.saveAs(path.join(OUT, 'demo.webm'))
  film.save(path.join(OUT, 'events.json'))
})
