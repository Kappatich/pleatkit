import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { alertsFromEnv, PROMPT_VERSION, sendAlert, type Alert, type AlertSink } from '@pleatkit/agent'
import { diffBaseline } from './baseline.js'
import { budgetFromEnv } from './budget.js'
import { PRIVATE_EVALS_DIR } from './apps.js'
import { BASELINE_FILE, EVALS_DIR, REPO_ROOT, RESULTS_DIR, setDir } from './tasks.js'
import type { Baseline, SuiteResult } from './types.js'

/**
 * `pnpm eval:weekly` (brainstorm 17 §20, stage 5 block 6): the weekly drift check.
 *
 * 1. Replays every set that has a baseline (`baseline.scripted.json` → the scripted transcripts, `baseline.json` →
 *    `live`, `baseline.<set>.json` → `<set>`) and the blind sets, offline and free, each as `eval:replay -- --set <set>`
 *    in a child process; a set regresses when `diffBaseline` finds a task whose share of passing trials dropped.
 * 2. Unless `--no-live` or no `PLEATKIT_API_KEY`: records the 14 demo tasks × 1 with the configured model into the set
 *    `weekly-<date>` (`eval:record -- --live --tasks demo --set weekly-<date>`) under `PLEATKIT_EVAL_BUDGET_USD`
 *    (default $0.30 here; a cap above $1 needs `--force`), and compares it with `evals/baseline.json` (below).
 * 3. Drift (a regressed set, a set that could not be replayed, or the live run ≥ 2 tasks below the baseline) sends one
 *    `eval-drift` alert through the agent server's channel (`PLEATKIT_ALERT_WEBHOOK`, `PLEATKIT_ALERT_EMAIL_*`).
 * 4. Writes `evals/results/weekly-<date>.json` (and `weekly-<date>.html`, the live run's report) and prints a summary.
 *    Exit 0: no drift; 1: drift (alert sent when a channel is set); 2: configuration error.
 *
 * The live comparison. `baseline.json` sums three trials per task, the weekly run has one. The baseline's expected
 * passes for one trial are the sum of each task's pass share (`passes / trials`; 14.0 when every trial passed);
 * the run is `expected − passes` tasks below it, over the tasks that ran and are in the baseline. Drift at ≥ 2: one
 * flaky task is noise, two is a signal (§20). The tasks listed as "below" failed now and passed in some baseline trial.
 *
 * Options: `--no-live`, `--force` (a cap above $1), `--no-alert` (print the alert, send nothing), `--sets a,b` (replay
 * only these; `scripted` is the scripted transcripts), `--date YYYY-MM-DD`, `--no-browser` / `--no-typecheck` (passed on).
 */

/** Sets replayed although they have no baseline: their pass counts are reported, they cannot regress. */
export const EXTRA_SETS = ['blind-ab', 'blind-me']
/** The live run is drift when it is this many tasks below the baseline's expected passes. */
export const LIVE_DRIFT_TASKS = 2
export const DEFAULT_WEEKLY_BUDGET_USD = 0.3
export const MAX_WEEKLY_BUDGET_USD = 1
/** The name `eval:replay` takes for the scripted transcripts (no `--set`). */
export const SCRIPTED = 'scripted'

export interface SetSpec {
  /** `scripted`, `live` or a named set. */
  name: string
  /** The `--set` value; absent for the scripted transcripts. */
  set?: string
  /** The baseline file, or null for a set replayed without one (the blind sets). */
  baselineFile: string | null
}

/** The folders whose baselines `eval:weekly` replays: this one, and the private clone's when `PLEATKIT_PRIVATE_EVALS` is set. */
export const BASELINE_DIRS = [EVALS_DIR, ...(PRIVATE_EVALS_DIR ? [PRIVATE_EVALS_DIR] : [])]

/**
 * Every set with a baseline in `evalsDirs` (the first folder wins a name), then the extra sets (once each). Without
 * the private clone only the scripted demo set is found and the blind sets are left out: they are skipped quietly.
 */
export function discoverSets(evalsDirs: string | string[] = BASELINE_DIRS, extra = PRIVATE_EVALS_DIR ? EXTRA_SETS : []): SetSpec[] {
  const out: SetSpec[] = []
  for (const evalsDir of typeof evalsDirs === 'string' ? [evalsDirs] : evalsDirs) {
    const files = fs.existsSync(evalsDir) ? fs.readdirSync(evalsDir).filter((f) => /^baseline(\.[a-z0-9][a-z0-9.-]*)?\.json$/.test(f)).sort() : []
    for (const f of files) {
      const mid = f.slice('baseline'.length, -'.json'.length).replace(/^\./, '')
      const file = path.join(evalsDir, f)
      const name = mid || 'live'
      if (out.some((s) => s.name === name)) continue
      if (!mid) out.push({ name: 'live', set: 'live', baselineFile: file })
      else if (mid === SCRIPTED) out.push({ name: SCRIPTED, baselineFile: file })
      else out.push({ name: mid, set: mid, baselineFile: file })
    }
  }
  for (const e of extra) if (!out.some((s) => s.name === e)) out.push({ name: e, set: e, baselineFile: null })
  // scripted first, then live, then the rest by name: the order a reader expects
  const rank = (s: SetSpec) => (s.name === SCRIPTED ? 0 : s.name === 'live' ? 1 : 2)
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

export interface SetOutcome {
  name: string
  /** `regressed`: a task's pass share fell; `no-baseline`: counted only; `error`: the replay did not produce results. */
  status: 'ok' | 'regressed' | 'no-baseline' | 'error'
  runs: number
  passingRuns: number
  tasks: number
  /** Tasks whose every run passed. */
  passingTasks: number
  regressions: string[]
  fixes: string[]
  /** In the baseline, not replayed (transcripts gone?): reported, not an alert. */
  missing: string[]
  /** Not in the baseline yet (pinned later) and failing now: reported, not an alert (nothing to regress from). */
  newFailing: string[]
  baseline: { file: string; promptVersion: string; passRate: number } | null
  aborted?: string
  error?: string
}

const rel = (p: string) => path.relative(REPO_ROOT, p).replace(/\\/g, '/')

/** The verdict on one replayed set: its pass counts and, with a baseline, its regressions. */
export function judgeSet(spec: SetSpec, s: SuiteResult | null, base: Baseline | null, error?: string): SetOutcome {
  const empty = { runs: 0, passingRuns: 0, tasks: 0, passingTasks: 0, regressions: [], fixes: [], missing: [], newFailing: [] }
  const baseline = base && spec.baselineFile ? { file: rel(spec.baselineFile), promptVersion: base.promptVersion, passRate: base.passRate } : null
  if (!s) return { name: spec.name, status: 'error', ...empty, baseline, error: error ?? 'the replay wrote no results' }
  const byTask = new Map<string, boolean>()
  for (const r of s.runs) byTask.set(r.taskId, (byTask.get(r.taskId) ?? true) && r.pass)
  const counts = { runs: s.runs.length, passingRuns: s.runs.filter((r) => r.pass).length, tasks: byTask.size, passingTasks: [...byTask.values()].filter(Boolean).length }
  const aborted = s.aborted ? { aborted: s.aborted.reason } : {}
  if (!base || !spec.baselineFile) return { name: spec.name, status: 'no-baseline', ...counts, regressions: [], fixes: [], missing: [], newFailing: [], baseline: null, ...aborted }
  const d = diffBaseline(s, base)
  return { name: spec.name, status: d.regressions.length ? 'regressed' : 'ok', ...counts, regressions: d.regressions, fixes: d.fixes, missing: d.missing, newFailing: d.added.filter((id) => byTask.get(id) === false), baseline, ...aborted }
}

export interface LiveOutcome {
  /** `below`: ≥ LIVE_DRIFT_TASKS under the baseline; `skipped`: --no-live or no key; `error`: the record wrote no results. */
  status: 'ok' | 'below' | 'no-baseline' | 'skipped' | 'error'
  set?: string
  reason?: string
  /** Tasks that ran (and are in the baseline, when there is one). */
  tasks: number
  passes: number
  /** The baseline's expected passes over the same tasks for one trial. */
  expected: number | null
  /** expected − passes, rounded to 0.01; never negative. */
  tasksBelow: number
  /** Failed now, passed in at least one baseline trial. */
  failed: string[]
  costUsd: number
  capUsd: number | null
  model?: string
  aborted?: string
}

const shareOf = (t: Baseline['tasks'][string]): number => (t.trials ? (t.passes ?? 0) / t.trials : t.pass ? 1 : 0)
const round2 = (n: number) => Math.round(n * 100) / 100

/** The live run against `baseline.json` (see the header for the measure). */
export function judgeLive(s: SuiteResult, base: Baseline | null, threshold = LIVE_DRIFT_TASKS): LiveOutcome {
  const byTask = new Map<string, boolean>()
  for (const r of s.runs) byTask.set(r.taskId, (byTask.get(r.taskId) ?? true) && r.pass)
  const common = {
    ...(s.set ? { set: s.set } : {}),
    costUsd: s.budget.spentUsd,
    capUsd: s.budget.capUsd,
    ...(s.model ? { model: s.model } : {}),
    ...(s.aborted ? { aborted: s.aborted.reason } : {}),
  }
  if (!base) {
    return { status: 'no-baseline', ...common, tasks: byTask.size, passes: [...byTask.values()].filter(Boolean).length, expected: null, tasksBelow: 0, failed: [] }
  }
  const ids = [...byTask.keys()].filter((id) => base.tasks[id])
  const passes = ids.filter((id) => byTask.get(id)).length
  const expected = round2(ids.reduce((t, id) => t + shareOf(base.tasks[id]!), 0))
  const tasksBelow = Math.max(0, round2(expected - passes))
  const failed = ids.filter((id) => !byTask.get(id) && shareOf(base.tasks[id]!) > 0)
  return { status: tasksBelow >= threshold ? 'below' : 'ok', ...common, tasks: ids.length, passes, expected, tasksBelow, failed }
}

export const skippedLive = (reason: string): LiveOutcome => ({ status: 'skipped', reason, tasks: 0, passes: 0, expected: null, tasksBelow: 0, failed: [], costUsd: 0, capUsd: null })

/** PLEATKIT_EVAL_BUDGET_USD for the live part: $0.30 when unset; above $1 only with --force. */
export function weeklyBudget(env: Record<string, string | undefined>, force: boolean): { capUsd: number } | { error: string } {
  let cap: number | null
  try {
    cap = budgetFromEnv(env)
  } catch (e) {
    return { error: (e as Error).message }
  }
  const capUsd = cap ?? DEFAULT_WEEKLY_BUDGET_USD
  if (capUsd > MAX_WEEKLY_BUDGET_USD && !force) {
    return { error: `PLEATKIT_EVAL_BUDGET_USD=${capUsd} is above the weekly check's $${MAX_WEEKLY_BUDGET_USD} (14 tasks × 1 cost about $0.15): lower it or pass --force.` }
  }
  return { capUsd }
}

export interface Decision {
  drift: boolean
  regressed: SetOutcome[]
  broken: SetOutcome[]
  liveBelow: boolean
}

/** Drift: a regressed set, a set that could not be replayed, or the live run ≥ LIVE_DRIFT_TASKS below the baseline. */
export function decide(sets: SetOutcome[], live: LiveOutcome): Decision {
  const regressed = sets.filter((s) => s.status === 'regressed')
  const broken = sets.filter((s) => s.status === 'error')
  const liveBelow = live.status === 'below'
  return { drift: regressed.length > 0 || broken.length > 0 || liveBelow, regressed, broken, liveBelow }
}

const usd = (n: number) => `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`
const list = (xs: string[], max = 5) => (xs.length > max ? `${xs.slice(0, max).join(', ')} +${xs.length - max}` : xs.join(', '))

export interface WeeklySummary {
  date: string
  startedAt: string
  finishedAt: string
  promptVersion: string
  drift: boolean
  sets: SetOutcome[]
  live: LiveOutcome
  costUsd: number
  report: { json: string; html: string | null }
  runUrl: string | null
  alert: { sent: number; channels: number; note?: string } | null
  exitCode: 0 | 1 | 2
}

/** The alert: a one-line title and a few lines of text (which sets, how many tasks below, the cost, the report). */
export function alertText(s: Pick<WeeklySummary, 'date' | 'sets' | 'live' | 'costUsd' | 'report' | 'runUrl'>): { title: string; text: string } {
  const d = decide(s.sets, s.live)
  const parts = [
    ...(d.regressed.length ? [`${d.regressed.length} set${d.regressed.length > 1 ? 's' : ''} regressed`] : []),
    ...(d.broken.length ? [`${d.broken.length} set${d.broken.length > 1 ? 's' : ''} could not be replayed`] : []),
    ...(d.liveBelow ? [`live run ${s.live.tasksBelow} tasks below the baseline`] : []),
  ]
  const lines = [
    ...d.regressed.map((x) => `Regressed: ${x.name}: ${list(x.regressions)} (${x.passingTasks} of ${x.tasks} tasks pass)`),
    ...d.broken.map((x) => `Could not replay: ${x.name}: ${(x.error ?? '').split('\n')[0]!.slice(0, 200)}`),
    ...(s.live.status === 'skipped'
      ? [`Live run: skipped (${s.live.reason})`]
      : s.live.status === 'error'
        ? [`Live run: failed (${s.live.reason})`]
        : [
            `Live run ${s.live.set ?? ''}: ${s.live.passes} of ${s.live.tasks} tasks pass${s.live.expected !== null ? `, the baseline expects ${s.live.expected}: ${s.live.tasksBelow} below` : ' (no baseline)'}${s.live.failed.length ? ` (failed: ${list(s.live.failed)})` : ''}${s.live.aborted ? `; stopped: ${s.live.aborted}` : ''}`,
          ]),
    `Cost: ${usd(s.costUsd)}${s.live.capUsd !== null ? ` (cap ${usd(s.live.capUsd)})` : ''}`,
    `Report: ${s.report.json}${s.report.html ? `, ${s.report.html}` : ''}`,
    ...(s.runUrl ? [`Run: ${s.runUrl}`] : []),
  ]
  return { title: `Weekly eval drift ${s.date}: ${parts.join('; ') || 'none'}`, text: lines.join('\n') }
}

export function driftAlert(s: Pick<WeeklySummary, 'date' | 'sets' | 'live' | 'costUsd' | 'report' | 'runUrl'>): Omit<Alert, 'at'> {
  const { title, text } = alertText(s)
  const d = decide(s.sets, s.live)
  return {
    kind: 'eval-drift',
    severity: d.regressed.length || d.liveBelow ? 'warning' : 'info',
    appId: 'pleatkit-evals',
    title,
    details: {
      text,
      regressed: Object.fromEntries(d.regressed.map((x) => [x.name, x.regressions])),
      notReplayed: d.broken.map((x) => x.name),
      liveTasksBelow: s.live.tasksBelow,
      costUsd: Math.round(s.costUsd * 10000) / 10000,
      report: s.report.json,
    },
  }
}

/** Send the drift alert through the sinks; `null` sinks (--no-alert) prints it instead. */
export async function sendDriftAlert(s: Parameters<typeof driftAlert>[0], sinks: AlertSink[] | null, log: (l: string) => void): Promise<NonNullable<WeeklySummary['alert']>> {
  const alert = driftAlert(s)
  if (sinks === null) {
    log(`alert (not sent, --no-alert):\n${alert.title}\n${String(alert.details.text)}`)
    return { sent: 0, channels: 0, note: '--no-alert' }
  }
  if (!sinks.length) {
    log('drift, but no alert channel is set: PLEATKIT_ALERT_WEBHOOK and/or PLEATKIT_ALERT_EMAIL_URL + PLEATKIT_ALERT_EMAIL_TO')
    return { sent: 0, channels: 0, note: 'no channel configured' }
  }
  const sent = await sendAlert(alert, sinks, log)
  log(`alert sent to ${sent} of ${sinks.length} channel(s)`)
  return { sent, channels: sinks.length }
}

// ---------------------------------------------------------------------------------------------------------------
// The run: child processes for the replays and the live record, injectable for tests.

export type ChildResult = { result: SuiteResult; code: number } | { error: string; code: number }

export interface WeeklyDeps {
  env: Record<string, string | undefined>
  /** `eval:replay` of one set (no `set`: the scripted transcripts). */
  replay(spec: SetSpec, passOn: string[]): Promise<ChildResult>
  /** `eval:record --live --tasks demo --set <set>` with the cap. */
  record(set: string, capUsd: number, passOn: string[]): Promise<ChildResult>
  /** The live run's HTML report; returns its path or null. */
  report?(set: string, out: string): Promise<string | null>
  loadBaseline(file: string): Baseline | null
  /** The sets to replay (default: discoverSets()). */
  sets?: SetSpec[]
  writeSummary(file: string, s: WeeklySummary): void
  log(line: string): void
  now(): Date
}

const flagIn = (argv: string[], name: string) => argv.includes(`--${name}`)
const valueIn = (argv: string[], name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

export async function runWeekly(argv: string[], deps: WeeklyDeps): Promise<WeeklySummary | { exitCode: 2; error: string }> {
  const startedAt = deps.now()
  const date = valueIn(argv, 'date') ?? startedAt.toISOString().slice(0, 10)
  if (!/^\d{4}-\d\d-\d\d$/.test(date)) return { exitCode: 2, error: `--date must be YYYY-MM-DD, got "${date}"` }
  const noAlert = flagIn(argv, 'no-alert')
  let sinks: AlertSink[] | null = null
  if (!noAlert) {
    try {
      sinks = alertsFromEnv(deps.env).sinks
    } catch (e) {
      return { exitCode: 2, error: (e as Error).message }
    }
  }
  const wantLive = !flagIn(argv, 'no-live')
  const hasKey = Boolean(deps.env.PLEATKIT_API_KEY)
  let capUsd: number | null = null
  if (wantLive && hasKey) {
    const b = weeklyBudget(deps.env, flagIn(argv, 'force'))
    if ('error' in b) return { exitCode: 2, error: b.error }
    capUsd = b.capUsd
  }
  const all = deps.sets ?? discoverSets()
  const only = valueIn(argv, 'sets')?.split(',').filter(Boolean)
  if (only) {
    const unknown = only.filter((n) => !all.some((s) => s.name === n))
    if (unknown.length) return { exitCode: 2, error: `--sets: no baseline or blind set named ${unknown.join(', ')} (known: ${all.map((s) => s.name).join(', ')})` }
  }
  const specs = only ? all.filter((s) => only.includes(s.name)) : all
  const passOn = ['no-browser', 'no-typecheck'].filter((f) => flagIn(argv, f)).map((f) => `--${f}`)

  const sets: SetOutcome[] = []
  for (const spec of specs) {
    deps.log(`— replay ${spec.name}${spec.baselineFile ? ` vs ${rel(spec.baselineFile)}` : ' (no baseline)'}`)
    const r = await deps.replay(spec, passOn)
    const base = spec.baselineFile ? deps.loadBaseline(spec.baselineFile) : null
    const o = 'result' in r ? judgeSet(spec, r.result, base) : judgeSet(spec, null, base, r.error)
    deps.log(`  ${setLine(o)}`)
    sets.push(o)
  }

  const liveSet = `weekly-${date}`
  const jsonFile = path.join(RESULTS_DIR, `weekly-${date}.json`)
  let html: string | null = null
  let live: LiveOutcome
  if (!wantLive) live = skippedLive('--no-live')
  else if (!hasKey) live = skippedLive('no PLEATKIT_API_KEY')
  else {
    deps.log(`— live: 14 demo tasks × 1 into ${rel(setDir(liveSet))}, cap ${usd(capUsd!)}`)
    const r = await deps.record(liveSet, capUsd!, passOn)
    if ('result' in r) {
      live = judgeLive(r.result, deps.loadBaseline(BASELINE_FILE))
      if (deps.report) html = await deps.report(liveSet, path.join(RESULTS_DIR, `weekly-${date}.html`))
    } else live = { ...skippedLive(''), status: 'error', reason: r.error.split('\n')[0]!.slice(0, 300), capUsd }
    deps.log(`  ${liveLine(live)}`)
  }

  const costUsd = live.costUsd
  const runUrl = deps.env.GITHUB_RUN_ID && deps.env.GITHUB_REPOSITORY ? `${deps.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${deps.env.GITHUB_REPOSITORY}/actions/runs/${deps.env.GITHUB_RUN_ID}` : null
  const base = { date, sets, live, costUsd, report: { json: rel(jsonFile), html: html ? rel(html) : null }, runUrl }
  const d = decide(sets, live)
  // a live record that failed outright (no results) is a configuration problem (key, model, network), not drift
  const exitCode: 0 | 1 | 2 = d.drift ? 1 : live.status === 'error' ? 2 : 0
  const alert = d.drift ? await sendDriftAlert(base, sinks, deps.log) : null
  const summary: WeeklySummary = { ...base, startedAt: startedAt.toISOString(), finishedAt: deps.now().toISOString(), promptVersion: PROMPT_VERSION, drift: d.drift, alert, exitCode }
  deps.writeSummary(jsonFile, summary)
  for (const l of summaryLines(summary)) deps.log(l)
  return summary
}

function setLine(o: SetOutcome): string {
  if (o.status === 'error') return `${o.name}: COULD NOT REPLAY: ${(o.error ?? '').split('\n')[0]}`
  const head = `${o.name}: ${o.passingTasks} of ${o.tasks} tasks pass (${o.passingRuns} of ${o.runs} runs)`
  if (o.status === 'no-baseline') return `${head}; no baseline`
  return `${head}; ${o.regressions.length ? `REGRESSED: ${o.regressions.join(', ')}` : 'no regression'}${o.fixes.length ? `; fixed: ${o.fixes.join(', ')}` : ''}${o.newFailing.length ? `; new in the set, not pinned, failing: ${o.newFailing.join(', ')}` : ''}${o.missing.length ? `; not replayed: ${o.missing.join(', ')}` : ''}${o.aborted ? `; stopped: ${o.aborted}` : ''}`
}

function liveLine(l: LiveOutcome): string {
  if (l.status === 'skipped') return `live: skipped (${l.reason})`
  if (l.status === 'error') return `live: FAILED (${l.reason})`
  return `live ${l.set ?? ''}: ${l.passes} of ${l.tasks} tasks pass${l.expected !== null ? `, baseline expects ${l.expected}: ${l.tasksBelow} below${l.status === 'below' ? ' (DRIFT)' : ''}` : ', no baseline'}${l.failed.length ? `; failed: ${l.failed.join(', ')}` : ''}; ${usd(l.costUsd)}${l.model ? ` on ${l.model}` : ''}${l.aborted ? `; stopped: ${l.aborted}` : ''}`
}

export function summaryLines(s: WeeklySummary): string[] {
  return [
    '',
    `weekly eval check ${s.date} (prompt ${s.promptVersion}): ${s.drift ? 'DRIFT' : 'no drift'}`,
    ...s.sets.map((o) => `  ${setLine(o)}`),
    `  ${liveLine(s.live)}`,
    `  cost ${usd(s.costUsd)}; summary ${s.report.json}${s.report.html ? `; report ${s.report.html}` : ''}`,
    ...(s.alert ? [`  alert: ${s.alert.note ?? `sent to ${s.alert.sent} of ${s.alert.channels} channel(s)`}`] : []),
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// The real children: `tsx src/cli.ts …` in evals/, output passed through with a prefix.

const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli')

/** The environment of a replay: without the live part's dollar cap (exported for tests). */
export function replayEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { PLEATKIT_EVAL_BUDGET_USD: _cap, ...rest } = env
  void _cap
  return rest
}

function runCli(args: string[], env: NodeJS.ProcessEnv, prefix: string, log: (l: string) => void): Promise<{ code: number; tail: string[] }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX_CLI, 'src/cli.ts', ...args], { cwd: EVALS_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const tail: string[] = []
    const onData = (buf: Buffer) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        log(`${prefix}${line}`)
        tail.push(line)
        if (tail.length > 20) tail.shift()
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (e) => resolve({ code: 1, tail: [...tail, e.message] }))
    child.on('close', (code) => resolve({ code: code ?? 1, tail }))
  })
}

/** A results file written by this child (not one left from an earlier run or another process before it started). */
function freshResult(file: string, since: number): SuiteResult | null {
  if (!fs.existsSync(file) || fs.statSync(file).mtimeMs < since - 1000) return null
  return JSON.parse(fs.readFileSync(file, 'utf8')) as SuiteResult
}

function realDeps(): WeeklyDeps {
  const log = (l: string) => console.log(l)
  return {
    env: process.env,
    async replay(spec, passOn) {
      const since = Date.now()
      // a replay costs nothing, but the runner counts the recorded transcripts' cost against PLEATKIT_EVAL_BUDGET_USD:
      // the live part's cap must not stop the replays (the first live run stopped apps and awkward half-way)
      const r = await runCli(['replay', ...(spec.set ? ['--set', spec.set] : []), ...passOn], replayEnv(process.env), `  [${spec.name}] `, log)
      const result = freshResult(path.join(RESULTS_DIR, spec.set ? `replay-${spec.set}.json` : 'replay.json'), since)
      return result ? { result, code: r.code } : { error: r.tail.slice(-3).join(' | ') || `exit ${r.code}`, code: r.code }
    },
    async record(set, capUsd, passOn) {
      const since = Date.now()
      const r = await runCli(['record', '--live', '--tasks', 'demo', '--set', set, ...passOn], { ...process.env, PLEATKIT_EVAL_BUDGET_USD: String(capUsd) }, '  [live] ', log)
      const result = freshResult(path.join(setDir(set), 'record.json'), since)
      return result ? { result, code: r.code } : { error: r.tail.slice(-3).join(' | ') || `exit ${r.code}`, code: r.code }
    },
    async report(set, out) {
      const r = await runCli(['report', '--set', set, '--from', 'record', '--baseline', 'live', '--out', out], process.env, '  [report] ', log)
      return r.code === 0 && fs.existsSync(out) ? out : null
    },
    loadBaseline: (file) => (fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Baseline) : null),
    writeSummary(file, s) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n')
    },
    log,
    now: () => new Date(),
  }
}

const isMain = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  const norm = (p: string) => path.resolve(p).replace(/\.[cm]?[jt]s$/, '').toLowerCase()
  return norm(entry) === norm(fileURLToPath(import.meta.url))
})()

if (isMain) {
  runWeekly(process.argv.slice(2), realDeps()).then(
    (s) => {
      if ('error' in s) console.error(s.error)
      process.exit(s.exitCode)
    },
    (e: Error) => {
      console.error(e.stack ?? e.message)
      process.exit(2)
    },
  )
}

