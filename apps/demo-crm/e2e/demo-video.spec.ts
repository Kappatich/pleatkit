import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { DOCS } from './helpers'

// The 60-second demo (ARCHITECTURE §8): request → the card changes → Undo → a backend request goes to the
// admin → the admin dashboard → bob's card is unchanged. Recorded headless with Playwright's recordVideo,
// scripted provider paced by MORPHKIT_SCRIPTED_DELAY_MS; scripts/record-demo.mjs converts it to docs/demo.mp4.
// Never runs in the normal e2e suite.
test.skip(process.env.MORPHKIT_VIDEO !== '1', 'set MORPHKIT_VIDEO=1 (pnpm demo:video) to record the demo')

const SIZE = { width: 1280, height: 800 }
const OUT = path.join(DOCS, '.video')

// Captions and a visible pointer: the recording has no OS cursor.
const OVERLAY = `(() => {
  const install = () => {
    if (document.getElementById('demo-caption')) return
    const style = document.createElement('style')
    style.textContent = \`
      #demo-caption { position: fixed; left: 24px; bottom: 24px; z-index: 2147483600; max-width: 760px; padding: 12px 18px;
        border-radius: 0; border-left: 4px solid #e30613; background: #111; color: #fff; font: 600 20px/1.35 "Helvetica Neue", Helvetica, Arial, sans-serif;
        letter-spacing: -.01em; transition: opacity .25s; }
      #demo-caption small { display: block; font-weight: 400; font-size: 15px; color: #c4c4c4; margin-top: 2px; }
      #demo-caption:empty { opacity: 0; }
      #demo-pointer { position: fixed; z-index: 2147483601; width: 22px; height: 22px; margin: -4px 0 0 -4px; pointer-events: none;
        border-radius: 50%; background: rgba(227,6,19,.25); border: 2px solid #e30613; transition: transform .12s; }
      #demo-pointer.down { transform: scale(.7); background: rgba(227,6,19,.6); }
      #demo-badge { position: fixed; left: 24px; bottom: 112px; z-index: 2147483600; padding: 3px 10px;
        border-radius: 0; background: #fff; border: 1px solid #111; color: #4a4a4a; font: 500 11.5px/1.4 "JetBrains Mono", ui-monospace, Consolas, monospace; letter-spacing: .04em; pointer-events: none; }\`
    document.head.appendChild(style)
    const caption = document.createElement('div')
    caption.id = 'demo-caption'
    document.body.appendChild(caption)
    // honest about what is replayed: the model's answers; everything after them runs for real
    const badge = document.createElement('div')
    badge.id = 'demo-badge'
    badge.textContent = 'Scripted agent: recorded model answers. Compile, commit, undo and storage are real.'
    document.body.appendChild(badge)
    const pointer = document.createElement('div')
    pointer.id = 'demo-pointer'
    pointer.style.left = (window.__demoX ?? -50) + 'px'
    pointer.style.top = (window.__demoY ?? -50) + 'px'
    document.body.appendChild(pointer)
    addEventListener('mousemove', (e) => { pointer.style.left = e.clientX + 'px'; pointer.style.top = e.clientY + 'px' }, true)
    addEventListener('mousedown', () => pointer.classList.add('down'), true)
    addEventListener('mouseup', () => pointer.classList.remove('down'), true)
  }
  window.__caption = (title, sub) => {
    install()
    const el = document.getElementById('demo-caption')
    el.innerHTML = ''
    if (!title) return
    el.append(title)
    if (sub) { const s = document.createElement('small'); s.textContent = sub; el.append(s) }
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', install)
  else install()
})()`

async function caption(page: Page, title: string, sub = ''): Promise<void> {
  await page.evaluate(([t, s]) => (window as unknown as { __caption: (t: string, s: string) => void }).__caption(t!, s!), [title, sub])
}

const pause = (page: Page, ms: number) => page.waitForTimeout(ms)

/** Glide the pointer to the element, then click it: easier to follow than a jump. */
async function glideClick(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded()
  const box = (await target.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 })
  await pause(page, 180)
  await target.click()
}

async function type(page: Page, target: Locator, text: string): Promise<void> {
  await glideClick(page, target)
  await target.pressSequentially(text, { delay: 28 })
}

test('demo video (60 s): request, change, undo, backend request, admin, per-user versions', async ({ browser }) => {
  test.setTimeout(150_000)
  fs.rmSync(OUT, { recursive: true, force: true })
  const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: OUT, size: SIZE }, deviceScaleFactor: 1 })
  await context.addInitScript(OVERLAY)
  const page = await context.newPage()
  const app = `demo-video-${Date.now().toString(36)}`
  const card = page.getByTestId('customer-card')

  // Beat 1: a request in plain words, the card changes in place
  await page.goto(`/?user=alice&app=${app}`)
  await page.getByRole('button', { name: /Globex/ }).click()
  await expect(card).toContainText('Globex')
  await caption(page, 'A CRM built with morphkit. Alice is signed in.', 'She wants more in her customer card.')
  await page.mouse.move(640, 400)
  await pause(page, 2200)
  await glideClick(page, page.getByTestId('mk-chat-open'))
  await caption(page, 'Alice asks the agent in plain words', 'The agent may only rewrite the panels the developer marked as dynamic.')
  await type(page, page.getByTestId('mk-chat-input'), 'In the customer card add phone, city and source; highlight an overdue payment date in red')
  await pause(page, 500)
  await glideClick(page, page.getByTestId('mk-chat-send'))
  const turn = page.getByTestId('mk-chat-turn').first()
  await expect(turn).toHaveAttribute('data-status', 'applied', { timeout: 30_000 })
  await caption(page, 'Applied: compiled, swapped in without a reload', 'Phone, city and source appear; the overdue date turns red. One status line while it runs.')
  await page.mouse.move(560, 430, { steps: 20 })
  await pause(page, 4200)

  // Beat 2: undo
  await caption(page, 'Every edit is a version. Undo is one click.', 'The history reads like a timetable.')
  await glideClick(page, page.getByTestId('mk-chat-undo'))
  await expect(card.getByTestId('phone')).toHaveCount(0)
  await pause(page, 2600)
  await caption(page, 'Ask again, and the edit is back', 'History keeps every version of her page.')
  await type(page, page.getByTestId('mk-chat-input'), 'Show phone, city and source again, overdue date in red')
  await glideClick(page, page.getByTestId('mk-chat-send'))
  await expect(page.getByTestId('mk-chat-turn').nth(1)).toHaveAttribute('data-status', 'applied', { timeout: 30_000 })
  await pause(page, 2200)

  // Beat 3: a request that needs the server goes to the admin, nothing changes
  await caption(page, 'Some requests need the backend', 'The agent does not fake it: it hands the request to the team.')
  await type(page, page.getByTestId('mk-chat-input'), 'Add a discount field to deals and recalculate the amount on the server')
  await glideClick(page, page.getByTestId('mk-chat-send'))
  await expect(page.getByTestId('mk-chat-turn').nth(2)).toHaveAttribute('data-status', 'needs-backend', { timeout: 30_000 })
  await pause(page, 3200)

  // Beat 4: the admin sees every request, the diff and the tool log, and can roll back
  await page.goto(`/admin?app=${app}`)
  await expect(page.getByTestId('admin-row')).toHaveCount(3)
  await caption(page, 'The admin sees every request', 'Outcome and cost; an edit can be undone for one user.')
  await page.mouse.move(640, 300, { steps: 15 })
  await pause(page, 2600)
  const edit = page.locator('[data-testid="admin-row"][data-status="applied"]').first()
  await glideClick(page, edit)
  await expect(page.getByTestId('admin-diff').first()).toBeVisible()
  await caption(page, 'Code and diff stay here, never in the user\'s chat')
  await page.mouse.wheel(0, 260)
  await pause(page, 3600)

  // Beat 5: bob's card is unchanged
  await page.goto(`/?user=bob&app=${app}`)
  await page.getByRole('button', { name: /Globex/ }).click()
  await expect(card).toContainText('Globex')
  await expect(card.getByTestId('phone')).toHaveCount(0)
  await caption(page, 'Bob\'s card is unchanged', 'Each user gets their own version. morphkit: github.com/Kappatich/morphkit')
  await page.mouse.move(560, 420, { steps: 15 })
  await pause(page, 4000)

  const video = page.video()!
  await context.close()
  await video.saveAs(path.join(OUT, 'demo.webm'))
})
