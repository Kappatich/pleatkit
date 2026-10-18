import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { BrowserCase, BrowserGrader } from './runner.js'
import { DEMO_DIR, EVALS_DIR } from './tasks.js'
import type { GraderResult } from './types.js'

const OUT = path.join(EVALS_DIR, '.out', 'browser')

/** The demo build must contain the `?eval=1` hook the browser grader commits through. */
export function demoBuildProblem(): string | null {
  const assets = path.join(DEMO_DIR, 'dist', 'assets')
  if (!fs.existsSync(assets)) return 'apps/demo-crm/dist is missing: run "pnpm build" first'
  const hasHook = fs.readdirSync(assets).some((f) => f.endsWith('.js') && fs.readFileSync(path.join(assets, f), 'utf8').includes('__morphkitEval'))
  return hasHook ? null : 'apps/demo-crm/dist predates the eval hook (?eval=1): run "pnpm build" first'
}

/**
 * Runs `evals/browser/invariants.spec.ts` with Playwright (headless, its own ports) over the cases and reads one
 * result file per case. The servers start once for all cases.
 */
export function playwrightGrader(o: { log?: (line: string) => void } = {}): BrowserGrader {
  return async (cases: BrowserCase[]) => {
    const problem = demoBuildProblem()
    if (problem) throw new Error(problem)
    const results = path.join(OUT, 'results')
    fs.rmSync(results, { recursive: true, force: true })
    fs.mkdirSync(results, { recursive: true })
    const casesFile = path.join(OUT, 'cases.json')
    fs.writeFileSync(casesFile, JSON.stringify(cases))
    const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('@playwright/test/package.json')), 'cli.js')
    const output: string[] = []
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'test', '-c', path.join(EVALS_DIR, 'browser', 'playwright.config.ts')], {
        cwd: EVALS_DIR,
        env: { ...process.env, EVAL_BROWSER_CASES: casesFile, EVAL_BROWSER_OUT: results },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const onData = (d: Buffer) => {
        const text = d.toString()
        output.push(text)
        for (const line of text.split('\n')) if (line.trim()) o.log?.(`  [playwright] ${line.trimEnd()}`)
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('error', reject)
      child.on('close', (c) => resolve(c ?? 1))
    })
    const out: Record<string, GraderResult> = {}
    for (const c of cases) {
      const file = path.join(results, `${c.taskId}.json`)
      out[c.taskId] = fs.existsSync(file)
        ? (JSON.parse(fs.readFileSync(file, 'utf8')) as GraderResult)
        : { grader: 'browser', pass: false, reason: `no result from Playwright (exit ${code}): ${output.join('').slice(-400).replace(/\s+/g, ' ')}` }
    }
    return out
  }
}
