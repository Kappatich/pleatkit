import fs from 'node:fs'
import path from 'node:path'
import { configFromEnv, PROMPT_VERSION } from '@pleatkit/agent'
import { diffBaseline, pinBaseline } from './baseline.js'
import { budgetFromEnv, EvalBudget } from './budget.js'
import { playwrightGrader } from './browser.js'
import { typecheckerFromEnv } from './graders.js'
import { recordingFile, replayProvider, scriptedProvider, trialsIn } from './providers.js'
import { renderReport, type SanityResult } from './report.js'
import { passRate, runKey, runSuite } from './runner.js'
import { runSanity } from './sanity.js'
import { typecheckRootOf, type AppId } from './apps.js'
import { BASELINE_FILE, baselineFileOf, loadManifests, loadSuites, REPO_ROOT, REPORT_FILE, RESULTS_DIR, SCRIPTED_BASELINE_FILE, setDir, SUITES, type Suite } from './tasks.js'
import type { Baseline, EvalTask, SuiteResult, TaskRun } from './types.js'

/**
 * pnpm eval:record   produce the transcripts under evals/recordings from the scripted fixtures (offline)
 *                    (--live: from the configured model into the set `live`; needs PLEATKIT_API_KEY and
 *                    PLEATKIT_EVAL_BUDGET_USD; --trials n runs each task n times; --no-classifier skips the classifier)
 * pnpm eval:replay   run every task against its transcript (ReplayProvider), grade, compare with the baseline
 *                    (the scripted transcripts and baseline.scripted.json; --set live: every trial of the live series
 *                    and baseline.json)
 * pnpm eval:sanity   reference solutions pass every grader; the null agent fails every task that needs a change
 * pnpm eval:pin      pin the last replay results as evals/baseline.json
 * pnpm eval:report   write evals/report/index.html from the last replay (and sanity) results
 * Options: --tasks demo|apps|all (default demo; a replay of a named set takes every task it has transcripts for),
 * --only <id,id>, --set <name>, --no-browser (skip Playwright), --no-typecheck (skip tsc); report: --from
 * record|replay, --baseline scripted|live|<file>, --out <file>.
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
/** A path the user typed: relative to where pnpm was run (INIT_CWD), not to evals/ where the script runs. */
const fromCaller = (p: string) => path.resolve(process.env.INIT_CWD ?? process.cwd(), p)
const resultFile = (name: string) => path.join(RESULTS_DIR, `${name}.json`)
/** `--tasks demo|apps|all`: the task suites (the demo's 14, the foreign apps' 35). */
const tasksArg = value('tasks') ?? 'demo'
const suites: Suite[] = tasksArg === 'all' ? ['demo', 'apps'] : (tasksArg.split(',') as Suite[])
/** `--set <name>`: a named set of transcripts under evals/recordings/<name>/ (a live record defaults to `live`, or `apps` for the apps suite). */
const set = value('set') ?? (command === 'record' && flag('live') ? (tasksArg === 'apps' ? 'apps' : 'live') : undefined)
const resultName = (kind: string) => (set ? `${kind}-${set}` : kind)
/** The sanity results of a suite: `sanity` (demo), `sanity-apps`, `sanity-all`. */
const sanityName = tasksArg === 'demo' ? 'sanity' : `sanity-${tasksArg}`

function save(name: string, data: unknown): void {
  fs.mkdirSync(RESULTS_DIR, { recursive: true })
  fs.writeFileSync(resultFile(name), JSON.stringify(data, null, 2) + '\n')
}
function load<T>(file: string): T | null {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as T) : null
}

/**
 * DECISIONS 63.4: tsc runs when the app's node_modules are found: PLEATKIT_TYPECHECK_ROOT for every app when it is
 * set (empty: off), else each app's own folder.
 */
const typecheckers = new Map<AppId, ReturnType<typeof typecheckerFromEnv>>()
function typecheckFor(app: AppId) {
  if (flag('no-typecheck')) return null
  if (!typecheckers.has(app)) {
    const env = { ...process.env }
    if (env.PLEATKIT_TYPECHECK_ROOT === undefined) env.PLEATKIT_TYPECHECK_ROOT = typecheckRootOf(app) ?? ''
    typecheckers.set(app, typecheckerFromEnv(env))
  }
  return typecheckers.get(app)!
}
const browser = () => (flag('no-browser') || process.env.PLEATKIT_EVAL_BROWSER === '0' ? null : playwrightGrader({ log }))

function summary(s: SuiteResult): string {
  const failed = s.runs.filter((r) => !r.pass)
  const cost = s.runs.reduce((t, r) => t + r.costUsd, 0)
  const key = (r: TaskRun) => (r.trial === undefined ? r.taskId : runKey(r.taskId, r.trial))
  return [
    `${s.kind}${s.set ? ` (set ${s.set})` : ''}: ${s.runs.length - failed.length} of ${s.runs.length} runs pass (${Math.round(passRate(s) * 100)} %), cost $${cost.toFixed(4)}, prompt ${s.prompt.version} (prefix ≈ ${s.prompt.prefixTokens} tokens)`,
    ...failed.map((r: TaskRun) => `  FAIL ${key(r)}: ${r.graders.filter((g) => !g.pass).map((g) => `${g.grader}: ${g.reason.split('\n')[0]}`).join(' | ')}`),
    ...(s.aborted ? [`  ABORTED: ${s.aborted.reason}`] : []),
  ].join('\n')
}

async function main(): Promise<number> {
  if (set !== undefined && !/^[a-z0-9][a-z0-9.-]*$/.test(set)) {
    console.error(`--set must be lower-case letters, digits, dots and dashes, got "${set}"`)
    return 2
  }
  for (const su of suites) if (!(su in SUITES)) {
    console.error(`--tasks must be demo, apps or all, got "${tasksArg}"`)
    return 2
  }
  // a replay of a named set runs every task it holds transcripts for, whatever its suite
  const loadFrom: Suite[] = command === 'replay' && set && !value('tasks') ? ['demo', 'apps'] : suites
  const tasks = command === 'pin' || command === 'report' ? [] : loadSuites(loadFrom, only)
  if (command === 'replay' && set) for (let i = tasks.length - 1; i >= 0; i--) if (!trialsIn(tasks[i]!.id, setDir(set)).length) tasks.splice(i, 1)
  const manifests = command === 'pin' || command === 'report' ? {} : loadManifests(tasks)
  const budget = new EvalBudget(budgetFromEnv())
  const dir = setDir(set)
  const classify = !flag('no-classifier')
  const classifierMode = flag('sequential-classifier') ? ('sequential' as const) : undefined

  switch (command) {
    case 'record': {
      const live = flag('live')
      if (live && (!process.env.PLEATKIT_API_KEY || budget.capUsd === null)) {
        console.error('eval:record --live spends money: set PLEATKIT_API_KEY and PLEATKIT_EVAL_BUDGET_USD (e.g. 2).')
        return 2
      }
      const trials = Number(value('trials') ?? 1)
      if (!Number.isInteger(trials) || trials < 1) {
        console.error(`--trials must be a positive whole number, got "${value('trials')}"`)
        return 2
      }
      const provider = live ? configFromEnv(process.env).provider : null
      const run = live ? tasks : tasks.filter((t) => t.record?.fixture)
      // a named set is rewritten task by task: no stale trials of an earlier, longer run
      if (set) for (const t of run) for (const n of trialsIn(t.id, dir)) fs.rmSync(recordingFile(t.id, dir, n))
      const s = await runSuite({
        kind: 'record',
        agent: live ? 'live' : 'scripted',
        tasks: run,
        manifests,
        providerFor: (t) => provider ?? scriptedProvider(t),
        trials,
        ...(set ? { set } : {}),
        classify,
        ...(classifierMode ? { classifierMode } : {}),
        ...(provider ? { model: provider.model } : {}),
        budget,
        typecheckFor,
        // a live run is graded in the browser right away: its timings are the real ones, a replay's are not
        browser: live ? browser() : null,
        recordDir: dir,
        log,
      })
      save(resultName('record'), s)
      // the record results of a named set stay next to its transcripts: the only place with real latencies
      if (set) fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify(s, null, 2) + '\n')
      log(summary(s))
      const broken = s.runs.filter((r) => r.error)
      for (const r of broken) console.error(`  ${r.taskId}: the recording run failed: ${r.error}`)
      log(`wrote ${s.runs.filter((r) => r.recording).length} transcript(s) to ${rel(dir)}; spent $${s.budget.spentUsd.toFixed(4)}`)
      return broken.length || s.aborted ? 1 : 0
    }
    case 'replay': {
      const inSet = set ? tasks.filter((t) => trialsIn(t.id, dir).length) : tasks
      if (set && !inSet.length) {
        console.error(`No transcripts in ${rel(dir)}${only ? ` for ${only.join(', ')}` : ''}.`)
        return 1
      }
      const s = await runSuite({
        kind: 'replay',
        agent: 'replay',
        tasks: inSet,
        manifests,
        ...(set
          ? {
              set,
              trials: (t: EvalTask) => trialsIn(t.id, dir).length,
              providerFor: (t: EvalTask, trial: number) => replayProvider(t, dir, trialsIn(t.id, dir)[trial - 1]),
              recordingOf: (t: EvalTask, trial: number) => recordingFile(t.id, dir, trialsIn(t.id, dir)[trial - 1]),
            }
          : { providerFor: (t: EvalTask) => replayProvider(t), recordingOf: (t: EvalTask) => recordingFile(t.id) }),
        classify,
        ...(classifierMode ? { classifierMode } : {}),
        budget,
        typecheckFor,
        browser: browser(),
        log,
      })
      save(resultName('replay'), s)
      log(summary(s))
      const baseFile = baselineFileOf(set)
      const base = load<Baseline>(baseFile)
      if (!base) {
        log(`no baseline at ${rel(baseFile)} yet: pnpm eval:pin${set ? ` -- --set ${set}` : ''} pins these results`)
        return s.aborted ? 1 : 0
      }
      const d = diffBaseline(s, base)
      log(`baseline ${rel(baseFile)} (prompt ${base.promptVersion}): ${Math.round(base.passRate * 100)} % → ${Math.round(d.passRate.now * 100)} %; regressed: ${d.regressions.join(', ') || 'none'}; fixed: ${d.fixes.join(', ') || 'none'}`)
      if (d.regressions.length) console.error(`Regressions against ${rel(baseFile)}: ${d.regressions.join(', ')}`)
      return d.regressions.length || s.aborted ? 1 : 0
    }
    case 'sanity': {
      const r = await runSanity({ tasks, manifests, budget, typecheckFor, browser: browser(), log })
      save(sanityName, r)
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
      const s = load<SuiteResult>(resultFile(resultName('replay')))
      if (!s) {
        console.error(`No replay results to pin: run pnpm eval:replay${set ? ` -- --set ${set}` : ''} first.`)
        return 1
      }
      const recorded = [...new Set(s.runs.map((r) => r.recording?.promptVersion).filter(Boolean))]
      // scripted transcripts repeat fixed answers whatever the prompt; a live set must be recorded with the current one
      if (s.prompt.version !== PROMPT_VERSION || (set && recorded.some((v) => v !== PROMPT_VERSION))) {
        console.error(`The last replay ran with prompt ${s.prompt.version}${set ? ` on transcripts of ${recorded.join(', ')}` : ''}, the code is at ${PROMPT_VERSION}: ${set ? 're-record the set' : 'run pnpm eval:replay again'} before pinning.`)
        return 1
      }
      const b = pinBaseline(s)
      const file = baselineFileOf(set)
      fs.writeFileSync(file, JSON.stringify(b, null, 2) + '\n')
      log(`pinned ${Object.keys(b.tasks).length} task(s), pass rate ${Math.round(b.passRate * 100)} %, prompt ${b.promptVersion} → ${rel(file)}`)
      return 0
    }
    case 'report': {
      // --from record: the live record of a set (real latencies); default: the last replay
      const from = value('from') ?? 'replay'
      const s = load<SuiteResult>(resultFile(resultName(from))) ?? (set && from === 'record' ? load<SuiteResult>(path.join(dir, 'record.json')) : null)
      if (!s) {
        console.error(`No ${from} results${set ? ` for set ${set}` : ''}: run pnpm eval:${from}${set ? ` -- --set ${set}` : ''} first.`)
        return 1
      }
      const b = value('baseline')
      const baseFile = b === 'scripted' ? SCRIPTED_BASELINE_FILE : b === 'live' ? BASELINE_FILE : b ? fromCaller(b) : baselineFileOf(set)
      const html = renderReport(s, load<Baseline>(baseFile), set ? null : load<SanityResult>(resultFile(sanityName)))
      const out = value('out') ? fromCaller(value('out')!) : REPORT_FILE
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.writeFileSync(out, html)
      log(`wrote ${rel(out)} (${s.runs.length} runs, ${Math.round(passRate(s) * 100)} % pass; baseline ${rel(baseFile)})`)
      return 0
    }
    default:
      console.error('usage: tsx src/cli.ts record|replay|sanity|pin|report [--only id,id] [--set name] [--trials n] [--no-classifier] [--no-browser] [--no-typecheck] [--live] [--from record|replay] [--baseline scripted|live|file] [--out file]')
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
