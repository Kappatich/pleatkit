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
const PANELS = ['customer-card', 'deals-table', 'dashboard-panels']

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

function locate(page: Page, c: BrowserCheck): Locator {
  const scope = c.within ? page.getByTestId(c.within) : page.locator('body')
  return scope.getByTestId(c.testid)
}

async function runCheck(page: Page, c: BrowserCheck, problems: string[]): Promise<void> {
  const loc = locate(page, c)
  const name = `${c.within ? c.within + ' › ' : ''}${c.testid}`
  if (c.count !== undefined) await soft(problems, `${name} count`, () => expect(loc).toHaveCount(c.count!))
  if (c.count === 0) return
  const first = loc.first()
  if (c.count === undefined) await soft(problems, `${name} exists`, () => expect(first).toBeVisible())
  if (c.text !== undefined) await soft(problems, `${name} text`, () => expect(first).toHaveText(c.text!))
  if (c.contains !== undefined) await soft(problems, `${name} contains`, () => expect(first).toContainText(c.contains!))
  if (c.class !== undefined) await soft(problems, `${name} class`, () => expect(first).toHaveClass(new RegExp(c.class!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))))
  if (c.attr) await soft(problems, `${name} [${c.attr.name}]`, () => expect(first).toHaveAttribute(c.attr!.name, c.attr!.value))
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
    await page.goto(`/?user=alice&app=${app}&eval=1`)
    await page.waitForFunction(() => {
      const e = (window as unknown as { __pleatkitEval?: { getState(): { status: string } } }).__pleatkitEval
      return e?.getState().status === 'ready'
    })
    const customer = c.invariants.customer ?? 'Globex'
    await page.getByRole('button', { name: new RegExp(customer) }).click()
    await expect(page.getByTestId('customer-card')).toContainText(customer)

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
    for (const id of PANELS) await soft(problems, `panel ${id} renders`, () => expect(page.getByTestId(id)).toBeVisible())
    for (const check of c.invariants.checks) await runCheck(page, check, problems)
    if (pageErrors.length) problems.push(`page errors: ${pageErrors.slice(0, 3).join(' | ').slice(0, 300)}`)

    const result = problems.length
      ? { grader: 'browser', pass: false, reason: problems.join('; ') }
      : { grader: 'browser', pass: true, reason: `${c.invariants.checks.length} check(s) and ${PANELS.length} panels in the rendered app` }
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true })
      fs.writeFileSync(path.join(outDir, `${c.taskId}.json`), JSON.stringify(result))
      fs.writeFileSync(path.join(outDir, `${c.taskId}.net.log`), net.join('\n') + '\n')
    }
  })
}
