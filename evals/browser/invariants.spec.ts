import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { BrowserCase } from '../src/runner.js'
import type { BrowserCheck } from '../src/types.js'

/**
 * One test per eval run: open the demo app as a fresh user, commit the run's files through the engine (the same
 * `draft.commit('agent')` the chat runs after an answer, compiled and signed by the agent server), then check the
 * task's invariants in the rendered page. A failed invariant is recorded as the grader's result, not as a failed
 * test: the runner reads `<out>/<taskId>.json`.
 */
const casesFile = process.env.EVAL_BROWSER_CASES
const outDir = process.env.EVAL_BROWSER_OUT
const cases: BrowserCase[] = casesFile ? (JSON.parse(fs.readFileSync(casesFile, 'utf8')) as BrowserCase[]) : []
/** Panels of the demo that must render after any edit (protected by the eval, whatever the task). */
const DEMO_PANELS = ['customer-card', 'deals-table', 'dashboard-panels']
/** A foreign app's panel by its `<Dynamic id>`: the runtime's wrapper (`display: contents`) and what it renders. */
const panelSel = (id: string) => `[data-pleatkit-id="${id}"]`

async function soft(problems: string[], what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    // Playwright's message: "Error: expect(locator)… failed", then "Expected: …" and "Received: …" lines
    // eslint-disable-next-line no-control-regex -- strips the terminal colours Playwright puts in its messages
    const lines = (e as Error).message.replace(/\u001b\[\d+m/g, '').split('\n').map((l) => l.trim())
    const detail = lines.filter((l) => /^(Expected|Received)/.test(l)).map((l) => l.replace(/\s+/g, ' '))
    problems.push(`${what}: ${(detail.length ? detail.join(', ') : lines[0]!).slice(0, 200)}`)
  }
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function locate(page: Page, c: BrowserCheck): Locator {
  let loc = c.within ? page.getByTestId(c.within) : c.panel ? page.locator(panelSel(c.panel)) : page.locator('body')
  if (c.testid) loc = loc.getByTestId(c.testid)
  if (c.selector) loc = loc.locator(c.selector)
  if (c.role) loc = loc.getByRole(c.role as Parameters<Page['getByRole']>[0], c.name !== undefined ? { name: new RegExp(c.name, 'i') } : {})
  // the element whose whole text is this (any case, outer spaces ignored), not its ancestors
  if (c.byText !== undefined) loc = loc.getByText(new RegExp(`^\\s*${escRe(c.byText)}\\s*$`, 'i'))
  if (c.textMatches !== undefined) loc = loc.getByText(new RegExp(c.textMatches, 'i'))
  return loc
}

/**
 * The judge's screenshot (DECISIONS 75 Р3): the box around what the panel renders (the demo's panel by its test id; a
 * foreign app's `<Dynamic id>` wrapper is `display: contents`, so the union of its visible children), or the page.
 * Charts animate after a render (recharts: 1.5 s), so the page settles first.
 */
async function shotOf(page: Page, demo: boolean, panel: string | null, file: string): Promise<void> {
  await page.waitForTimeout(1_800)
  const clip = panel
    ? await page.evaluate(
        ({ panel, demo }) => {
          const root = demo ? document.querySelector(`[data-testid="${panel}"]`) : document.querySelector(`[data-pleatkit-id="${panel}"]`)
          if (!root) return null
          const boxes: DOMRect[] = []
          const visit = (el: Element) => {
            const r = el.getBoundingClientRect()
            if (getComputedStyle(el).display === 'contents' || (r.width === 0 && r.height === 0)) for (const c of Array.from(el.children)) visit(c)
            else if (r.width > 0 && r.height > 0) boxes.push(r)
          }
          if (demo) visit(root)
          else for (const c of Array.from(root.children)) visit(c)
          if (!boxes.length) return null
          const x = Math.max(0, Math.min(...boxes.map((b) => b.left)) + window.scrollX)
          const y = Math.max(0, Math.min(...boxes.map((b) => b.top)) + window.scrollY)
          const right = Math.max(...boxes.map((b) => b.right)) + window.scrollX
          const bottom = Math.max(...boxes.map((b) => b.bottom)) + window.scrollY
          return { x, y, width: Math.max(1, right - x), height: Math.max(1, Math.min(bottom - y, 2400)) }
        },
        { panel, demo },
      )
    : null
  // the drawer's launcher floats over the page's corner: not part of the edit
  const style = '[data-testid="mk-chat-open"]{visibility:hidden !important}'
  await page.screenshot({ path: file, animations: 'disabled', style, ...(clip ? { clip, fullPage: true } : {}) })
  if (process.env.EVAL_SHOT_DEBUG) await page.screenshot({ path: file.replace(/\.png$/, '.page.png'), animations: 'disabled', style, fullPage: true })
}

/** Visible landmarks of the page outside the panels (`aside`, `nav`, `header`, a sidebar), by tag, slot and text. */
async function shell(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('aside, nav, header, [data-slot="sidebar-container"]'))
      .filter((e) => !e.closest('[data-pleatkit-id], [data-testid="mk-chat"]'))
      .map((e) => ({ id: `${e.tagName.toLowerCase()}${e.getAttribute('data-slot') ? `[${e.getAttribute('data-slot')}]` : ''}`, text: (e.textContent ?? '').trim().replace(/\s+/g, ' '), box: e.getBoundingClientRect(), style: getComputedStyle(e) }))
      .filter((x) => x.box.width > 0 && x.box.height > 0 && x.style.display !== 'none' && x.style.visibility !== 'hidden')
      .map((x) => `${x.id} "${(x.text ?? '').slice(0, 40)}"`),
  )
}

/**
 * DECISIONS 80: deterministic checks on the "after" render of the changed panel, run before the visual-quality judge
 * so breakage a screenshot can hide fails the edit outright. Conservative, to avoid failing a good edit: horizontal
 * overflow of the panel, content spilling past the panel's right/bottom edge, text contrast under WCAG AA (reported
 * only when clearly low, < 3.0), a new interactive element with no accessible name, and console errors on commit.
 */
interface VisualMeasure {
  overflow: number
  spill: boolean
  nameless: number
  contrast: number
}

async function visualMeasure(page: Page, demo: boolean, panel: string | null): Promise<VisualMeasure> {
  return page.evaluate(
    ({ panel, demo }) => {
      const m = { overflow: 0, spill: false, nameless: 0, contrast: 21 }
      const root = (panel ? (demo ? document.querySelector(`[data-testid="${panel}"]`) : document.querySelector(`[data-pleatkit-id="${panel}"]`)) : document.body) as HTMLElement | null
      if (!root) return m
      // the panel's own box: for a foreign app's `display: contents` wrapper, the union of its children
      const boxOf = (el: Element): DOMRect => {
        if (getComputedStyle(el).display !== 'contents') return el.getBoundingClientRect()
        const rs = Array.from(el.children).map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0)
        if (!rs.length) return el.getBoundingClientRect()
        const l = Math.min(...rs.map((r) => r.left)), t = Math.min(...rs.map((r) => r.top)), r = Math.max(...rs.map((x) => x.right)), b = Math.max(...rs.map((x) => x.bottom))
        return new DOMRect(l, t, r - l, b - t)
      }
      const panelBox = boxOf(root)
      // 1. horizontal overflow of a real (non-contents) panel element
      const scroller = getComputedStyle(root).display === 'contents' ? (root.firstElementChild as HTMLElement | null) : root
      if (scroller) m.overflow = Math.max(0, scroller.scrollWidth - scroller.clientWidth)
      // 2. a descendant spilling well past the panel's right or bottom edge (overlapping neighbouring content)
      const slack = 8
      for (const el of Array.from(root.querySelectorAll('*')).slice(0, 2000)) {
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue
        const r = (el as HTMLElement).getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        if (r.right > panelBox.right + slack || r.bottom > panelBox.bottom + slack + panelBox.height) {
          m.spill = true
          break
        }
      }
      // 3. a new interactive element with no accessible name
      const accName = (el: Element): string => {
        const aria = el.getAttribute('aria-label')?.trim()
        if (aria) return aria
        const title = el.getAttribute('title')?.trim()
        if (title) return title
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
        if (text) return text
        const img = el.querySelector('img[alt], svg[aria-label], svg title')
        const alt = img?.getAttribute('alt')?.trim() ?? img?.getAttribute('aria-label')?.trim() ?? img?.querySelector('title')?.textContent?.trim()
        return alt ?? ''
      }
      const nameless = Array.from(root.querySelectorAll('button, a[href], [role="button"]')).filter((el) => {
        const r = (el as HTMLElement).getBoundingClientRect()
        return r.width > 0 && r.height > 0 && !accName(el) && !el.getAttribute('aria-hidden')
      })
      m.nameless = nameless.length
      // 4. text contrast: parse rgb(a) and compute WCAG ratio; report only clearly low ( < 3.0 )
      const lum = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
      const rgb = (v: string): [number, number, number, number] | null => { const m = v.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1]!.split(',').map((x) => parseFloat(x)); return [p[0]!, p[1]!, p[2]!, p[3] ?? 1] }
      const bgOf = (el: Element): [number, number, number] => { for (let e: Element | null = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c && c[3] > 0.3) return [c[0], c[1], c[2]] } return [255, 255, 255] }
      const ratio = (a: [number, number, number], b: [number, number, number]) => { const la = 0.2126 * lum(a[0]) + 0.7152 * lum(a[1]) + 0.0722 * lum(a[2]); const lb = 0.2126 * lum(b[0]) + 0.7152 * lum(b[1]) + 0.0722 * lum(b[2]); const [hi, lo] = la > lb ? [la, lb] : [lb, la]; return (hi + 0.05) / (lo + 0.05) }
      let worst = 21
      for (const el of Array.from(root.querySelectorAll('*')).slice(0, 2000)) {
        const t = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 1)
        if (!t) continue
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden') continue
        const fg = rgb(cs.color)
        if (!fg || fg[3] < 0.5) continue
        worst = Math.min(worst, ratio([fg[0], fg[1], fg[2]], bgOf(el)))
      }
      m.contrast = worst
      return m
    },
    { panel, demo },
  )
}

/**
 * DECISIONS 80: what the edit broke, not what the app already had: each measurement is taken before and after the
 * commit and only a change for the worse counts (an icon-only button the release already has is not the edit's).
 */
function visualProblems(before: VisualMeasure | null, after: VisualMeasure, consoleErrors: number): string[] {
  const b = before ?? { overflow: 0, spill: false, nameless: 0, contrast: 21 }
  const out: string[] = []
  if (after.overflow > b.overflow + 4) out.push(`panel overflows horizontally by ${after.overflow}px (was ${b.overflow}px)`)
  if (after.spill && !b.spill) out.push('content spills outside the panel box')
  if (after.nameless > b.nameless) out.push(`${after.nameless - b.nameless} new button/link with no accessible name`)
  if (after.contrast < 3.0 && after.contrast < b.contrast - 0.05) out.push(`text contrast ${after.contrast.toFixed(1)}:1 is below WCAG AA (was ${b.contrast.toFixed(1)}:1)`)
  if (consoleErrors) out.push(`${consoleErrors} console error(s) after the commit`)
  return out
}

async function runCheck(page: Page, c: BrowserCheck, problems: string[]): Promise<void> {
  if (c.launcherOnTop) {
    await soft(problems, 'launcher on top', async () => {
      // the launcher lives in the chat's shadow root: Playwright finds it; elementFromPoint at its centre must be it
      const launcher = page.getByTestId('mk-chat-open')
      await expect(launcher).toBeVisible()
      const box = await launcher.boundingBox()
      if (!box) throw new Error('the launcher has no box')
      const top = await page.evaluate(({ x, y }) => {
        const hit = document.elementFromPoint(x, y)
        if (!hit) return 'nothing'
        const root = hit.shadowRoot
        const inner = root ? root.elementFromPoint(x, y) : null
        const el = inner ?? hit
        return el.closest('[data-testid="mk-chat-open"]') || (el.getAttribute('data-testid') ?? '') === 'mk-chat-open' ? 'launcher' : `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(/\s+/).slice(0, 3).join('.') : ''}`
      }, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
      if (top !== 'launcher') throw new Error(`Expected: the launcher on top at its centre, Received: ${top}`)
    })
    return
  }
  const loc = locate(page, c)
  const name = [c.within, c.panel, c.testid, c.selector, c.role && `${c.role}${c.name ? ` /${c.name}/` : ''}`, c.byText !== undefined ? `"${c.byText}"` : undefined, c.textMatches && `/${c.textMatches}/`].filter(Boolean).join(' › ')
  if (c.count !== undefined) await soft(problems, `${name} count`, () => expect(loc).toHaveCount(c.count!))
  if (c.count === 0) return
  const first = loc.first()
  // a panel itself is the runtime's `display: contents` wrapper: it is visible when what it renders is
  const onlyPanel = Boolean(c.panel) && !c.testid && !c.selector && !c.role && c.byText === undefined && c.textMatches === undefined
  if (c.count === undefined) await soft(problems, `${name} exists`, () => expect(onlyPanel ? page.locator(`${panelSel(c.panel!)} > *`).first() : first).toBeVisible())
  if (c.text !== undefined) await soft(problems, `${name} text`, () => expect(first).toHaveText(c.text!))
  if (c.contains !== undefined) await soft(problems, `${name} contains`, () => expect(first).toContainText(c.contains!))
  if (c.notContains !== undefined) await soft(problems, `${name} does not contain`, () => expect(first).not.toContainText(c.notContains!))
  if (c.matches !== undefined) await soft(problems, `${name} text matches`, () => expect(first).toHaveText(new RegExp(c.matches!, 'i')))
  if (c.class !== undefined) await soft(problems, `${name} class`, () => expect(first).toHaveClass(new RegExp(escRe(c.class!))))
  if (c.classMatches !== undefined)
    await soft(problems, `${name} class`, async () => {
      // on the element or inside it: a highlighted value is often a span within the field's element; with
      // classScope "around" also on its ancestors up to the panel (a struck-through or faded row)
      const ok = await first.evaluate(
        (el, { src, around }) => {
          const re = new RegExp(src)
          const nodes: Element[] = [el, ...Array.from(el.querySelectorAll('*'))]
          if (around) for (let p = el.parentElement; p && !p.hasAttribute('data-pleatkit-id') && p !== document.body; p = p.parentElement) nodes.push(p)
          return nodes.some((e) => re.test(e.getAttribute('class') ?? ''))
        },
        { src: c.classMatches!, around: c.classScope === 'around' },
      )
      if (!ok) throw new Error(`no class matching /${c.classMatches}/ on the element${c.classScope === 'around' ? ', its ancestors' : ''} or inside it (its class: "${(await first.getAttribute('class')) ?? ''}")`)
    })
  if (c.attr) await soft(problems, `${name} [${c.attr.name}]`, () => expect(first).toHaveAttribute(c.attr!.name, c.attr!.value))
  if (c.css)
    await soft(problems, `${name} ${c.css.prop}`, async () => {
      const v = await first.evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), c.css!.prop)
      if (!new RegExp(c.css!.matches).test(v)) throw new Error(`Expected: ${c.css!.prop} matching /${c.css!.matches}/, Received: ${v}`)
    })
  if (c.maxHeight !== undefined)
    await soft(problems, `${name} height`, async () => {
      const box = await first.boundingBox()
      if (!box || box.height > c.maxHeight!) throw new Error(`Expected: height ≤ ${c.maxHeight} px, Received: ${box ? Math.round(box.height) : 'no box'} px`)
    })
  if (c.click) {
    await soft(problems, `${name} click`, () => first.click({ timeout: 2_500 }))
    await page.waitForTimeout(300)
  }
}

for (const c of cases) {
  test(c.taskId, async ({ page }) => {
    const problems: string[] = []
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    // crm-07 (DECISIONS 70.8): every bundle and compile request with its status and timing, written next to the
    // result and quoted in it when the commit fails, so a load failure says which file failed and how
    const t0 = Date.now()
    const net: string[] = []
    const watched = (url: string) => /\/pleatkit\/b\/|\/agent\/v1\/compile/.test(url)
    page.on('response', (r) => void (watched(r.url()) && net.push(`${Date.now() - t0}ms ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`)))
    page.on('requestfailed', (r) => void (watched(r.url()) && net.push(`${Date.now() - t0}ms FAILED ${r.method()} ${new URL(r.url()).pathname}: ${r.failure()?.errorText ?? ''}`)))
    page.on('console', (m) => void (m.type() === 'error' && net.push(`${Date.now() - t0}ms console: ${m.text().slice(0, 200)}`)))
    const app = `eval-${c.taskId}-${Date.now().toString(36)}`
    const demo = !c.app || c.app === 'demo-crm'
    await page.goto(demo ? `/?user=alice&app=${app}&eval=1` : `${c.path ?? '/'}?app=${app}&eval=1`)
    await page.waitForFunction(() => {
      const e = (window as unknown as { __pleatkitEval?: { getState(): { status: string } } }).__pleatkitEval
      return e?.getState().status === 'ready'
    })
    if (demo) {
      const customer = c.invariants.customer ?? 'Globex'
      await page.getByRole('button', { name: new RegExp(customer) }).click()
      await expect(page.getByTestId('customer-card')).toContainText(customer)
    } else {
      // the route's panels have rendered their original version before the commit
      for (const id of c.panels ?? []) await page.locator(`${panelSel(id)} > *`).first().waitFor({ timeout: 30_000 })
    }

    // DECISIONS 75 Р3: the judge sees the changed panel before and after the commit
    const shoot = async (when: 'before' | 'after'): Promise<string | null> => {
      if (!c.shot || !outDir) return null
      const file = path.join(outDir, `${c.taskId}.${when}.png`)
      try {
        await shotOf(page, demo, c.shot.panel, file)
        return file
      } catch {
        return null
      }
    }
    const before = await shoot('before')
    // stage 5 block 4: an edit must not change the page outside the panels (the edits' CSS once hid shadcn-admin's
    // sidebar on every commit): the landmarks visible before the commit are still visible after it
    const shellBefore = await shell(page)
    const visualBefore = c.shot ? await visualMeasure(page, demo, c.shot.panel) : null
    const netAtCommit = net.length

    if (Object.keys(c.files).length || c.deleted.length) {
      const committed = await page.evaluate(
        async ({ files, deleted }) => {
          type Engine = { draft: { start(m: string): void; write(p: string, s: string): void; remove(p: string): void; commit(a: string): Promise<{ id: string }> } }
          const engine = (window as unknown as { __pleatkitEval: Engine }).__pleatkitEval
          try {
            engine.draft.start('eval')
            for (const [p, s] of Object.entries(files)) engine.draft.write(p, s)
            for (const p of deleted) engine.draft.remove(p)
            return { ok: true, id: (await engine.draft.commit('agent')).id }
          } catch (e) {
            return { ok: false, error: (e as Error).message }
          }
        },
        { files: c.files, deleted: c.deleted },
      )
      if (!committed.ok) problems.push(`commit rejected: ${committed.error?.slice(0, 300)} [network: ${net.join(' | ').slice(0, 600)}]`)
      // let React paint the swapped modules, and a render-time throw reach the error boundary
      await page.waitForTimeout(400)
    }

    // first, while a render-time throw still shows its banner (it rolls back by itself after 10 s)
    await soft(problems, 'no crash banner', () => expect(page.getByTestId('pleatkit-crash')).toHaveCount(0))
    // before the checks, which may click (a filter): the panel as the commit left it
    const after = before ? await shoot('after') : null
    const shellAfter = await shell(page)
    // by tag and text, not by position: a landmark the page adds after its data loads (block 5: mesa's channel note)
    // shifts the positions without hiding anything
    const remaining = [...shellAfter]
    const lost = shellBefore.filter((x) => {
      const at = remaining.indexOf(x)
      if (at < 0) return true
      remaining.splice(at, 1)
      return false
    })
    if (lost.length) problems.push(`the commit hid part of the page outside the panels: ${lost.join(', ')}`)
    // DECISIONS 80: deterministic pre-checks on the "after" render, for the judge to fail fast before the model
    const visual = c.shot ? visualProblems(visualBefore, await visualMeasure(page, demo, c.shot.panel), net.slice(netAtCommit).filter((l) => l.includes('console:')).length) : []
    const panels = demo ? DEMO_PANELS : (c.panels ?? [])
    for (const id of panels) await soft(problems, `panel ${id} renders`, () => expect(demo ? page.getByTestId(id) : page.locator(`${panelSel(id)} > *`).first()).toBeVisible())
    for (const check of c.invariants.checks) await runCheck(page, check, problems)
    if (pageErrors.length) problems.push(`page errors: ${pageErrors.slice(0, 3).join(' | ').slice(0, 300)}`)

    const shots = before && after ? { shots: { before, after } } : {}
    const vis = c.shot ? { visual } : {}
    const result = problems.length
      ? { grader: 'browser', pass: false, reason: problems.join('; '), ...shots, ...vis }
      : { grader: 'browser', pass: true, reason: `${c.invariants.checks.length} check(s) and ${panels.length} panels in the rendered app`, ...shots, ...vis }
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true })
      fs.writeFileSync(path.join(outDir, `${c.taskId}.json`), JSON.stringify(result))
      fs.writeFileSync(path.join(outDir, `${c.taskId}.net.log`), net.join('\n') + '\n')
    }
  })
}
