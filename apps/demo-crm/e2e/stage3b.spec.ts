import { expect, test, type Locator, type Page } from '@playwright/test'
import { adminUrl, openChat, openCrm } from './chat-helpers'

/** Paste an image into an element as the browser would after Ctrl+V of a screenshot. */
async function paste(target: Locator, png: Buffer): Promise<void> {
  await target.evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, png.toString('base64'))
}

/** Drag an image file over the chat drawer and drop it. */
async function drop(target: Locator, png: Buffer): Promise<void> {
  await target.evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }))
    el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, png.toString('base64'))
}

function captureAgentRequest(page: Page): () => Record<string, unknown> | null {
  let body: Record<string, unknown> | null = null
  page.on('request', (r) => {
    if (r.url().endsWith('/agent/run') && r.method() === 'POST') body = JSON.parse(r.postData() ?? '{}') as Record<string, unknown>
  })
  return () => body
}

test('screenshot input: paste and drop images, the request carries them and the DOM of the pointed panel', async ({ page }) => {
  await openCrm(page)
  const shot = await page.getByTestId('customer-card').screenshot()
  const sent = captureAgentRequest(page)
  await openChat(page)
  const input = page.getByTestId('mk-chat-input')

  // Ctrl+V of a screenshot: a thumbnail, nothing pasted as text; it can be removed
  await paste(input, shot)
  const thumbs = page.getByTestId('mk-chat-images').locator('img')
  await expect(thumbs).toHaveCount(1)
  await expect(input).toHaveValue('')
  await page.getByTestId('mk-chat-image-remove').click()
  await expect(page.getByTestId('mk-chat-images')).toHaveCount(0)

  // paste again, and drop a second one onto the drawer
  await paste(input, shot)
  await drop(page.getByTestId('mk-chat'), shot)
  await expect(thumbs).toHaveCount(2)
  expect(await thumbs.first().getAttribute('src')).toMatch(/^data:image\/png;base64,/)

  // point at the card, then send
  await page.getByTestId('mk-chat-pick').click()
  const card = page.getByTestId('customer-card')
  const box = (await card.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await input.pressSequentially('add phone, city and source like on my screenshot')
  await page.getByTestId('mk-chat-send').click()
  const turn = page.getByTestId('mk-chat-turn').first()
  await expect(turn).toHaveAttribute('data-status', 'applied')
  await expect(turn.getByTestId('mk-turn-images').locator('img')).toHaveCount(2)
  await expect(page.getByTestId('mk-chat-images')).toHaveCount(0)

  const body = sent()!
  const images = body.images as { mediaType: string; data: string }[]
  expect(images).toHaveLength(2)
  expect(images[0]!.mediaType).toBe('image/png')
  expect(images[0]!.data).not.toContain('data:')
  expect(body.target).toBe('customer-card')
  const dom = body.targetDom as string
  expect(dom).toContain('data-testid="customer-card"')
  expect(dom).toContain('Globex')
  expect(dom).not.toMatch(/<script|style=|onclick/i)

  await page.goto(adminUrl(page))
  await page.getByTestId('admin-row').first().click()
  await expect(page.getByTestId('admin-attachments')).toContainText('2 screenshot(s)')
})

test('screenshot input: at most 3 per request', async ({ page }) => {
  await openCrm(page)
  const shot = await page.getByTestId('customer-card').screenshot()
  await openChat(page)
  for (let i = 0; i < 4; i++) await paste(page.getByTestId('mk-chat-input'), shot)
  await expect(page.getByTestId('mk-chat-images').locator('img')).toHaveCount(3)
  await expect(page.getByTestId('mk-toast').filter({ hasText: 'Up to 3 screenshots' })).toBeVisible()
})
