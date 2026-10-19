import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildPrompt, digestsFromManifest, PROMPT_VERSION, readTranscript, RecordingProvider, runAgent, typecheckFromEnv, warmTypecheck, type ModelProvider, type TypecheckFn } from '@pleatkit/agent'
import type { PleatkitManifest } from '@pleatkit/runtime/compiler'
import { APPS, routeOf, type AppId } from './apps.js'
import { BudgetExceededError, EvalBudget, gradeBudget } from './budget.js'
import { gradeRun, type RunResult } from './graders.js'
import { recordingFile } from './providers.js'
import { codeDiff, designSystemOf, judgeGrader, readShot, type Judge } from './judge.js'
import { DEFAULT_TASK_BUDGET_USD, prepareTask, type PreparedTask } from './tasks.js'
import type { AgentKind, BrowserInvariants, EvalTask, GraderResult, PromptInfo, SuiteResult, TaskRun, Tokens } from './types.js'

/** What the browser grader needs of one run: the files to commit in the demo app and what to look for. */
export interface BrowserCase {
  taskId: string
  /** The task's app (absent: the demo) and the route to open there. */
  app?: AppId
  path?: string
  /** Panels that must render on that route after the commit. */
  panels?: string[]
  files: Record<string, string>
  deleted: string[]
  invariants: BrowserInvariants
  /** Screenshot the panel before and after the commit for the judge (null: the whole page). */
  shot?: { panel: string | null }
}

/** Grades the browser invariants of several runs at once (one demo app, one headless browser). */
export type BrowserGrader = (cases: BrowserCase[]) => Promise<Record<string, GraderResult>>

export interface SuiteOptions {
  kind: SuiteResult['kind']
  agent: AgentKind
  tasks: EvalTask[]
  /** The build manifest tasks run against: one for all (tests), or one per app (`manifests`, preferred when given). */
  manifest?: PleatkitManifest
  manifests?: Partial<Record<AppId, PleatkitManifest>>
  providerFor: (task: EvalTask, trial: number) => ModelProvider
  /** Runs per task (default 1): a number, or per task (a replay runs every transcript a set holds). */
  trials?: number | ((task: EvalTask) => number)
  /** Named set (`--set live`): its transcripts are `<task>.t<trial>.jsonl`; recorded in the result. */
  set?: string
  /** Run the cheap classifier first (default true, as the agent server does). */
  classify?: boolean
  /** DECISIONS 73.3: parallel (default, as the agent server) or sequential classifier. */
  classifierMode?: 'parallel' | 'sequential'
  /** The main model of a live run, recorded in the result. */
  model?: string
  budget?: EvalBudget
  /** tsc grader (PLEATKIT_TYPECHECK_ROOT); null skips it. */
  typecheck?: TypecheckFn | null
  /** tsc grader per app (each app's own node_modules); wins over `typecheck` when given. */
  typecheckFor?: (app: AppId) => TypecheckFn | null
  /**
   * DECISIONS 74.2: the agent loop's own type check per app, as the agent server runs it (on when the app's packages
   * are found). Default: `typecheckFromEnv(process.env)` for every app.
   */
  loopTypecheckFor?: (app: AppId) => TypecheckFn | null
  /** Playwright grader; null skips it. */
  browser?: BrowserGrader | null
  /** The visual-quality judge (DECISIONS 75 Р3): scores the browser grader's before/after screenshots of every edit. */
  judge?: Judge | null
  /** false: a replay does not charge its recorded cost to the run's cap (the judge's own spend still does). */
  chargeReplay?: boolean
  /** Record every run into `<dir>/<taskId>.jsonl`, or `<taskId>.t<trial>.jsonl` in a named set (RecordingProvider). */
  recordDir?: string
  /** Transcript each run replays, for the report (replay runs). */
  recordingOf?: (task: EvalTask, trial: number) => string | null
  log?: (line: string) => void
}

/** The manifest's digests in the cached prefix, as the agent server passes them. */
type PromptDigests = NonNullable<Parameters<typeof buildPrompt>[2]>
export const digestsOf = (m: PleatkitManifest): PromptDigests => digestsFromManifest(m)

/** Size of the cached prompt prefix for the demo app: what a prompt change costs on every request. */
export function promptInfo(manifest: PleatkitManifest, sample: PreparedTask): PromptInfo {
  const parts = buildPrompt(sample.request, undefined, digestsOf(manifest))
  const prefixChars = parts.instructions.length + parts.cached.length
  // DECISIONS 73.5, counted with the API: the English instructions ≈ 2.9 characters per token, the app's code ≈ 2.2,
  // the tool definitions ≈ 900 tokens (the old 3.5 characters per token missed 40 % of the demo's 7,467)
  return { version: PROMPT_VERSION, prefixChars, prefixTokens: Math.round(parts.instructions.length / 2.9 + parts.cached.length / 2.2) + 900 }
}

const firstTry = (r: RunResult): boolean | null => {
  const writes = r.log.filter((l) => l.tool === 'write_file' || l.tool === 'edit_file').length
  if (!writes) return null
  return !r.log.some((l) => ((l.tool === 'check' || l.tool === 'finish') && !l.ok) || (l.tool === 'check' && l.result.startsWith('FAILED')))
}

function tokensOf(r: RunResult): Tokens {
  return r.usage.reduce((t, u) => ({ input: t.input + u.inputTokens, output: t.output + u.outputTokens, cacheRead: t.cacheRead + u.cacheReadTokens, cacheWrite: t.cacheWrite + u.cacheWriteTokens }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
}

function promptVersionOf(file: string): string | null {
  try {
    const meta = readTranscript(file).find((l) => l.kind === 'meta')
    return meta && meta.kind === 'meta' ? meta.promptVersion : null
  } catch {
    return null
  }
}

/** Key of one run: the task id, or `<task>.t<trial>` when the task runs several times (browser cases, results). */
export const runKey = (taskId: string, trial?: number): string => (trial === undefined ? taskId : `${taskId}.t${trial}`)

/**
 * Runs every task through the agent loop in-process (the same `runAgent`, tools, check and limits as the agent
 * server, with the server's trusted input from the demo's build manifest), grades each result, then grades the
 * browser invariants of all runs in one headless session. Money is enforced per task and for the whole run.
 * With trials, each task runs that many times in a row; every run is graded and reported on its own.
 */
export async function runSuite(o: SuiteOptions): Promise<SuiteResult> {
  const log = o.log ?? (() => undefined)
  const budget = o.budget ?? new EvalBudget(null)
  const typecheck = o.typecheck ?? null
  const manifestOf = (t: Pick<EvalTask, 'app' | 'id'>): PleatkitManifest => {
    const m = o.manifests?.[t.app] ?? o.manifest
    if (!m) throw new Error(`no build manifest for ${t.app} (task ${t.id})`)
    return m
  }
  const typecheckOf = (app: AppId): TypecheckFn | null => (o.typecheckFor ? o.typecheckFor(app) : typecheck)
  const startedAt = new Date().toISOString()
  const runs: TaskRun[] = []
  const prepared = o.tasks.map((t) => prepareTask(t, manifestOf(t)))
  const trialsOf = (t: EvalTask): number => (typeof o.trials === 'function' ? o.trials(t) : (o.trials ?? 1))
  const numbered = o.set !== undefined || o.tasks.some((t) => trialsOf(t) > 1)
  const queue = prepared.flatMap((p) => Array.from({ length: trialsOf(p.task) }, (_, i) => ({ p, trial: i + 1 })))
  let aborted: SuiteResult['aborted']
  const results = new Map<string, RunResult>()
  const diffs = new Map<string, string>()
  const warmed = new Set<AppId>()
  const envTypecheck = o.loopTypecheckFor ? null : typecheckFromEnv(process.env)
  const loopTypecheckOf = (app: AppId): TypecheckFn | null => (o.loopTypecheckFor ? o.loopTypecheckFor(app) : envTypecheck)

  for (const [i, { p, trial }] of queue.entries()) {
    const task = p.task
    const key = numbered ? runKey(task.id, trial) : task.id
    try {
      budget.admit(key, queue.slice(i).map((x) => (numbered ? runKey(x.p.task.id, x.trial) : x.p.task.id)))
    } catch (e) {
      if (!(e instanceof BudgetExceededError)) throw e
      aborted = { reason: e.message, notRun: queue.slice(i).map((x) => (numbered ? runKey(x.p.task.id, x.trial) : x.p.task.id)) }
      log(`ABORT ${e.message}`)
      break
    }
    const cap = task.budgetUsd ?? DEFAULT_TASK_BUDGET_USD
    const limit = budget.limitFor(cap)
    // block 5 (brainstorm 17 §4): as the agent server does at start, warm the app's type check once before its first
    // task, outside every timing (PLEATKIT_TYPECHECK_WARM=0: the cold path, for the before/after measurement)
    const tc = loopTypecheckOf(task.app)
    if (tc && !warmed.has(task.app) && !['0', 'off', 'false'].includes((process.env.PLEATKIT_TYPECHECK_WARM ?? '').toLowerCase())) {
      warmed.add(task.app)
      const ms = await warmTypecheck(tc, { files: p.trusted.base, readonly: p.request.readonly, coreTypes: p.request.coreTypes, context: p.request.context, components: p.request.components })
      log(`type check of ${task.app} warmed in ${Math.round(ms)} ms`)
    }
    let provider = o.providerFor(task, trial)
    let tmp: string | null = null
    if (o.recordDir) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-eval-rec-'))
      provider = new RecordingProvider(provider, { dir: tmp, taskId: task.id, ...(numbered ? { trial } : {}) })
    }
    const result = await runAgent(p.request, provider, {
      limits: { maxCostUsd: limit },
      protected: p.trusted.protected,
      base: p.trusted.base,
      typecheck: loopTypecheckOf(task.app),
      digests: digestsOf(manifestOf(task)),
      ...(o.classify === false ? { classify: false } : {}),
      ...(o.classifierMode ? { classifierMode: o.classifierMode } : {}),
    })
    let recording: TaskRun['recording']
    if (o.recordDir && tmp) {
      const written = (provider as RecordingProvider).files
      fs.mkdirSync(o.recordDir, { recursive: true })
      const dest = recordingFile(task.id, o.recordDir, numbered ? trial : undefined)
      if (written.length) {
        // one transcript per run: the classifier and the main loop of this run
        fs.writeFileSync(dest, written.map((f) => fs.readFileSync(f, 'utf8')).join(''))
        recording = { file: path.basename(dest), promptVersion: PROMPT_VERSION }
      }
      fs.rmSync(tmp, { recursive: true, force: true })
    } else {
      const file = o.recordingOf?.(task, trial) ?? null
      if (file) recording = { file: path.basename(file), promptVersion: promptVersionOf(file) }
    }
    results.set(key, result)
    // DECISIONS 82.3: what the edit changed in the code, for the judge
    diffs.set(key, codeDiff(p.request.files, { ...p.request.files, ...result.files }))
    const costUsd = result.usage.reduce((s, u) => s + (u.costUsd ?? 0), 0)
    // `eval:judge -- --set`: the replayed transcripts' money was spent when they were recorded; only the judge counts
    if (!(o.agent === 'replay' && o.chargeReplay === false)) budget.charge(costUsd)
    const graders = [...(await gradeRun(p, result, typecheckOf(task.app))), gradeBudget(costUsd, cap, result.stopReason, limit)]
    runs.push({
      taskId: task.id,
      ...(task.app !== 'demo-crm' ? { app: task.app } : {}),
      ...(numbered ? { trial } : {}),
      title: task.title,
      agent: o.agent,
      expectedVerdict: task.expected.verdict,
      verdict: result.verdict,
      summary: result.summary,
      ...(result.backendNote ? { backendNote: result.backendNote } : {}),
      ...(result.backendQuote ? { backendQuote: result.backendQuote } : {}),
      changedFiles: Object.keys(result.files),
      modelCalls: result.modelCalls,
      firstTry: firstTry(result),
      costUsd,
      unpricedModels: [...new Set(result.usage.filter((u) => u.costUsd === null && u.calls > 0).map((u) => u.model))],
      tokens: tokensOf(result),
      ...(provider.model ? { model: provider.model.replace(/^replay:/, '') } : {}),
      usage: result.usage,
      ms: result.timings.totalMs,
      timings: result.timings,
      ...(result.stopReason ? { stopReason: result.stopReason } : {}),
      graders,
      pass: false,
      ...(result.error ? { error: result.error } : {}),
      ...(recording ? { recording } : {}),
    })
    log(`${key}: ${result.verdict} (${graders.filter((g) => !g.pass).map((g) => g.grader).join(', ') || 'all in-process graders pass'})`)
  }

  const keyOf = (r: TaskRun) => (numbered ? runKey(r.taskId, r.trial) : r.taskId)
  const cases: BrowserCase[] = runs.flatMap((r) => {
    const task = o.tasks.find((t) => t.id === r.taskId)!
    const inv = task.invariants?.browser
    const res = results.get(keyOf(r))!
    if (!inv) return []
    const route = inv.path ?? routeOf(task.app, task.target ?? inv.checks.find((c) => c.panel)?.panel)
    const app = task.app !== 'demo-crm' ? { app: task.app, path: route, panels: APPS[task.app].panels[route] ?? [] } : {}
    const changed = Object.keys(res.files).length + res.deleted.length > 0
    const shot = o.judge && changed ? { shot: { panel: shotPanel(task, Object.keys(res.files)) } } : {}
    return [{ taskId: keyOf(r), ...app, files: res.files, deleted: res.deleted, invariants: inv, ...shot }]
  })
  let browserResults: Record<string, GraderResult> = {}
  const browserRan = Boolean(o.browser && cases.length)
  if (o.browser && cases.length) {
    log(`browser: ${cases.length} case(s) in ${[...new Set(cases.map((c) => c.app ?? 'demo-crm'))].join(', ')} (headless)`)
    browserResults = await o.browser(cases)
  }
  for (const r of runs) {
    const hasCase = cases.some((c) => c.taskId === keyOf(r))
    r.graders.push(
      browserResults[keyOf(r)] ??
        (hasCase
          ? o.browser
            ? { grader: 'browser', pass: false, reason: 'the browser grader returned no result for this task' }
            : { grader: 'browser', pass: true, skipped: true, reason: 'browser grader switched off (--no-browser)' }
          : { grader: 'browser', pass: true, skipped: true, reason: 'no browser invariants' }),
    )
  }
  let judgeCostUsd = 0
  if (o.judge) {
    for (const r of runs) {
      const shots = browserResults[keyOf(r)]?.shots
      const task = o.tasks.find((t) => t.id === r.taskId)!
      if (!r.changedFiles.length) {
        r.graders.push(judgeGrader(null, 'nothing changed'))
        continue
      }
      const before = shots ? readShot(shots.before) : null
      const after = shots ? readShot(shots.after) : null
      if (!before || !after) {
        r.graders.push(judgeGrader(null, 'no screenshots (the browser grader did not run for this task)'))
        continue
      }
      try {
        const diff = diffs.get(keyOf(r))
        const j = await o.judge({ request: task.request, designSystem: designSystemOf(manifestOf(task)), before, after, ...(shots && browserResults[keyOf(r)]?.visual?.length ? { preCheck: browserResults[keyOf(r)]!.visual } : {}), ...(r.verdict === 'partial' && r.backendQuote ? { backendQuote: r.backendQuote } : {}), ...(diff ? { diff } : {}) })
        budget.charge(j.costUsd)
        judgeCostUsd += j.costUsd
        r.judge = j
        r.graders.push(judgeGrader(j))
        log(`judge ${keyOf(r)}: ${j.score}/5 ${j.reason}`)
      } catch (e) {
        r.graders.push(judgeGrader(null, `the judge failed: ${(e as Error).message.slice(0, 200)}`))
      }
    }
  }
  for (const r of runs) r.pass = r.graders.every((g) => g.pass || g.advisory)

  return {
    kind: o.kind,
    startedAt,
    finishedAt: new Date().toISOString(),
    prompt: suitePromptInfo(o.tasks, manifestOf, prepared),
    budget: { capUsd: budget.capUsd, spentUsd: budget.spentUsd },
    ...(o.judge ? { judgeCostUsd } : {}),
    ...(aborted ? { aborted } : {}),
    browser: browserRan ? 'ran' : 'skipped',
    typecheck: typecheck ? 'ran' : 'skipped',
    ...(o.set !== undefined ? { set: o.set } : {}),
    ...(o.model ? { model: o.model } : {}),
    ...(o.classify === false ? { classifier: false } : {}),
    ...(o.classifierMode === 'sequential' ? { classifierMode: 'sequential' as const } : {}),
    runs,
  }
}

/**
 * The panel the judge looks at: the whole page when the edit changed two panels, else the one the user pointed at,
 * else the panel of the browser checks, else a changed file that is a panel of the task's app, else the whole page.
 */
export function shotPanel(task: EvalTask, changed: string[]): string | null {
  // an edit that changed two panels (two asks in one) is judged on the whole page, or the judge misses one of them
  const all = Object.values(APPS[task.app].panels).flat()
  const touched = new Set(changed.map((f) => f.replace(/^.*\//, '').replace(/\.\w+$/, '')).filter((id) => all.includes(id)))
  if (touched.size >= 2) return null
  if (task.target) return task.target
  const checks = task.invariants?.browser?.checks ?? []
  const fromChecks = checks.find((c) => c.panel)?.panel ?? checks.find((c) => c.within)?.within
  if (fromChecks) return fromChecks
  const panels = Object.values(APPS[task.app].panels).flat()
  for (const f of changed) {
    const id = f.replace(/^.*\//, '').replace(/\.\w+$/, '')
    if (panels.includes(id)) return id
  }
  return null
}

/** promptInfo of the first task's app; with several apps, each app's prefix too. */
function suitePromptInfo(tasks: EvalTask[], manifestOf: (t: EvalTask) => PleatkitManifest, prepared: PreparedTask[]): PromptInfo {
  const first = prepared[0] ?? prepareTask(tasks[0]!, manifestOf(tasks[0]!))
  const info = promptInfo(manifestOf(first.task), first)
  const apps = [...new Set(tasks.map((t) => t.app))]
  if (apps.length < 2) return info
  const byApp = Object.fromEntries(
    apps.map((a) => {
      const p = prepared.find((x) => x.task.app === a)!
      const i = promptInfo(manifestOf(p.task), p)
      return [a, { prefixChars: i.prefixChars, prefixTokens: i.prefixTokens }]
    }),
  )
  return { ...info, byApp }
}

export const passRate = (s: Pick<SuiteResult, 'runs'>): number => (s.runs.length ? s.runs.filter((r) => r.pass).length / s.runs.length : 0)

/** Per task, in run order: how many of its runs (trials) passed. */
export function taskPasses(s: Pick<SuiteResult, 'runs'>): Record<string, { passes: number; trials: number }> {
  const out: Record<string, { passes: number; trials: number }> = {}
  for (const r of s.runs) {
    const row = (out[r.taskId] ??= { passes: 0, trials: 0 })
    row.trials++
    if (r.pass) row.passes++
  }
  return out
}

/** Pass rate of each grader over the runs where it applied (skipped runs are left out). */
export function graderRates(s: Pick<SuiteResult, 'runs'>): Record<string, { pass: number; total: number }> {
  const out: Record<string, { pass: number; total: number }> = {}
  for (const r of s.runs)
    for (const g of r.graders) {
      const row = (out[g.grader] ??= { pass: 0, total: 0 })
      if (g.skipped) continue
      row.total++
      if (g.pass) row.pass++
    }
  return out
}
