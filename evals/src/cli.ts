import fs from 'node:fs'
import path from 'node:path'
import { configFromEnv, PROMPT_VERSION } from '@pleatkit/agent'
import { diffBaseline, pinBaseline } from './baseline.js'
import { budgetFromEnv, EvalBudget } from './budget.js'
import { playwrightGrader } from './browser.js'
import { typecheckerFromEnv } from './graders.js'
import { recordingFile, replayProvider, scriptedProvider } from './providers.js'
import { renderReport, type SanityResult } from './report.js'
import { passRate, runSuite } from './runner.js'
import { runSanity } from './sanity.js'
import { BASELINE_FILE, DEMO_DIR, loadManifest, loadTasks, RECORDINGS_DIR, REPO_ROOT, REPORT_FILE, RESULTS_DIR } from './tasks.js'
import type { Baseline, SuiteResult, TaskRun } from './types.js'

/**
 * pnpm eval:record   produce the transcripts under evals/recordings from the scripted fixtures (offline)
 *                    (--live: from the configured model; needs PLEATKIT_API_KEY and PLEATKIT_EVAL_BUDGET_USD)
 * pnpm eval:replay   run every task against its transcript (ReplayProvider), grade, compare with the baseline
 * pnpm eval:sanity   reference solutions pass every grader; the null agent fails every task that needs a change
 * pnpm eval:pin      pin the last replay results as evals/baseline.json
 * pnpm eval:report   write evals/report/index.html from the last replay (and sanity) results
 * Options: --only <id,id>, --no-browser (skip Playwright), --no-typecheck (skip tsc).
 */
const args = process.argv.slice(2)
const command = args[0]
const flag = (name: string) => args.includes(`--${name}`)
const value = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const only = value('only')?.split(',').filter(Boolean)
const log = (line: string) => console.log(line)
const rel = (p: string) => path.relative(REPO_ROOT, p).replace(/\\/g, '/')
const resultFile = (name: string) => path.join(RESULTS_DIR, `${name}.json`)

function save(name: string, data: unknown): void {
  fs.mkdirSync(RESULTS_DIR, { recursive: true })
  fs.writeFileSync(resultFile(name), JSON.stringify(data, null, 2) + '\n')
}
function load<T>(file: string): T | null {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as T) : null
}

/** DECISIONS 63.4: tsc runs when the app's node_modules are found (PLEATKIT_TYPECHECK_ROOT, else the demo app). */
function typecheck() {
  if (flag('no-typecheck')) return null
  const env = { ...process.env }
  if (env.PLEATKIT_TYPECHECK_ROOT === undefined && fs.existsSync(path.join(DEMO_DIR, 'node_modules', 'react'))) env.PLEATKIT_TYPECHECK_ROOT = DEMO_DIR
  return typecheckerFromEnv(env)
}
const browser = () => (flag('no-browser') || process.env.PLEATKIT_EVAL_BROWSER === '0' ? null : playwrightGrader({ log }))

function summary(s: SuiteResult): string {
  const failed = s.runs.filter((r) => !r.pass)
  const cost = s.runs.reduce((t, r) => t + r.costUsd, 0)
  return [
    `${s.kind}: ${s.runs.length - failed.length} of ${s.runs.length} tasks pass (${Math.round(passRate(s) * 100)} %), cost $${cost.toFixed(4)}, prompt ${s.prompt.version} (prefix ≈ ${s.prompt.prefixTokens} tokens)`,
    ...failed.map((r: TaskRun) => `  FAIL ${r.taskId}: ${r.graders.filter((g) => !g.pass).map((g) => `${g.grader}: ${g.reason.split('\n')[0]}`).join(' | ')}`),
    ...(s.aborted ? [`  ABORTED: ${s.aborted.reason}`] : []),
  ].join('\n')
}

async function main(): Promise<number> {
  const manifest = command === 'pin' || command === 'report' ? null : loadManifest()
  const tasks = command === 'pin' || command === 'report' ? [] : loadTasks(undefined, only)
  const budget = new EvalBudget(budgetFromEnv())

  switch (command) {
    case 'record': {
      const live = flag('live')
      if (live && (!process.env.PLEATKIT_API_KEY || budget.capUsd === null)) {
        console.error('eval:record --live spends money: set PLEATKIT_API_KEY and PLEATKIT_EVAL_BUDGET_USD (e.g. 2).')
        return 2
      }
      const provider = live ? configFromEnv(process.env).provider : null
      const s = await runSuite({ kind: 'record', agent: live ? 'live' : 'scripted', tasks: live ? tasks : tasks.filter((t) => t.record?.fixture), manifest: manifest!, providerFor: (t) => provider ?? scriptedProvider(t), budget, typecheck: typecheck(), browser: null, recordDir: RECORDINGS_DIR, log })
      save('record', s)
      log(summary(s))
      const broken = s.runs.filter((r) => r.error)
      for (const r of broken) console.error(`  ${r.taskId}: the recording run failed: ${r.error}`)
      log(`wrote ${s.runs.filter((r) => r.recording).length} transcript(s) to ${rel(RECORDINGS_DIR)}`)
      return broken.length || s.aborted ? 1 : 0
    }
    case 'replay': {
      const s = await runSuite({ kind: 'replay', agent: 'replay', tasks, manifest: manifest!, providerFor: (t) => replayProvider(t), recordingOf: (t) => recordingFile(t.id), budget, typecheck: typecheck(), browser: browser(), log })
      save('replay', s)
      log(summary(s))
      const base = load<Baseline>(BASELINE_FILE)
      if (!base) {
        log('no baseline yet: pnpm eval:pin pins these results')
        return s.aborted ? 1 : 0
      }
      const d = diffBaseline(s, base)
      log(`baseline (prompt ${base.promptVersion}): ${Math.round(base.passRate * 100)} % → ${Math.round(d.passRate.now * 100)} %; regressed: ${d.regressions.join(', ') || 'none'}; fixed: ${d.fixes.join(', ') || 'none'}`)
      if (d.regressions.length) console.error(`Regressions against ${rel(BASELINE_FILE)}: ${d.regressions.join(', ')}`)
      return d.regressions.length || s.aborted ? 1 : 0
    }
    case 'sanity': {
      const r = await runSanity({ tasks, manifest: manifest!, budget, typecheck: typecheck(), browser: browser(), log })
      save('sanity', r)
      log(summary(r.reference))
      log(summary(r.null))
      if (r.problems.length) {
        console.error(`Sanity check failed:\n  ${r.problems.join('\n  ')}`)
        return 1
      }
      const needChange = tasks.filter((t) => t.expected.change).length
      log(`sanity holds: ${r.reference.runs.length} reference solutions pass every grader; the null agent fails all ${needChange} tasks that require a change`)
      return 0
    }
    case 'pin': {
      const s = load<SuiteResult>(resultFile('replay'))
      if (!s) {
        console.error('No replay results to pin: run pnpm eval:replay first.')
        return 1
      }
      if (s.prompt.version !== PROMPT_VERSION) {
        console.error(`The last replay ran with prompt ${s.prompt.version}, the code is at ${PROMPT_VERSION}: run pnpm eval:replay again before pinning.`)
        return 1
      }
      const b = pinBaseline(s)
      fs.writeFileSync(BASELINE_FILE, JSON.stringify(b, null, 2) + '\n')
      log(`pinned ${Object.keys(b.tasks).length} task(s), pass rate ${Math.round(b.passRate * 100)} %, prompt ${b.promptVersion} → ${rel(BASELINE_FILE)}`)
      return 0
    }
    case 'report': {
      const s = load<SuiteResult>(resultFile('replay'))
      if (!s) {
        console.error('No replay results: run pnpm eval:replay first.')
        return 1
      }
      const html = renderReport(s, load<Baseline>(BASELINE_FILE), load<SanityResult>(resultFile('sanity')))
      fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true })
      fs.writeFileSync(REPORT_FILE, html)
      log(`wrote ${rel(REPORT_FILE)} (${s.runs.length} tasks, ${Math.round(passRate(s) * 100)} % pass)`)
      return 0
    }
    default:
      console.error('usage: tsx src/cli.ts record|replay|sanity|pin|report [--only id,id] [--no-browser] [--no-typecheck] [--live]')
      return 2
  }
}

main().then(
  (code) => process.exit(code),
  (e: Error) => {
    console.error(e.message)
    process.exit(1)
  },
)
