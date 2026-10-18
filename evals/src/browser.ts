import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { BrowserCase, BrowserGrader } from './runner.js'
import { APPS, type AppId } from './apps.js'
import { EVALS_DIR } from './tasks.js'
import type { GraderResult } from './types.js'

const OUT = path.join(EVALS_DIR, '.out', 'browser')

/** The app's build must contain the `?eval=1` hook the browser grader commits through. */
export function buildProblem(app: AppId = 'demo-crm'): string | null {
  const a = APPS[app]
  const assets = path.join(a.dir, 'dist', 'assets')
  const rel = path.relative(path.resolve(EVALS_DIR, '..'), a.dir).split(path.sep).join('/')
  if (!fs.existsSync(assets)) return `${rel}/dist is missing: run "${a.build}" first`
  const hasHook = fs.readdirSync(assets).some((f) => f.endsWith('.js') && fs.readFileSync(path.join(assets, f), 'utf8').includes('__pleatkitEval'))
  return hasHook ? null : `${rel}/dist predates the eval hook (?eval=1): run "${a.build}" first`
}
/** @deprecated the demo's `buildProblem`. */
export const demoBuildProblem = (): string | null => buildProblem('demo-crm')

/**
 * Runs `evals/browser/invariants.spec.ts` with Playwright (headless, its own ports) over the cases and reads one
 * result file per case. The servers start once for all cases.
 */
export function playwrightGrader(o: { log?: (line: string) => void } = {}): BrowserGrader {
  return async (cases: BrowserCase[]) => {
    // one Playwright run (one set of servers) per app
    const out: Record<string, GraderResult> = {}
    for (const app of [...new Set(cases.map((c) => c.app ?? 'demo-crm'))]) Object.assign(out, await gradeApp(app, cases.filter((c) => (c.app ?? 'demo-crm') === app), o))
    return out
  }
}

async function gradeApp(app: AppId, cases: BrowserCase[], o: { log?: (line: string) => void }): Promise<Record<string, GraderResult>> {
  const problem = buildProblem(app)
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
      env: { ...process.env, EVAL_BROWSER_CASES: casesFile, EVAL_BROWSER_OUT: results, EVAL_APP: app },
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
