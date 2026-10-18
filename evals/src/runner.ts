import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildPrompt, PROMPT_VERSION, readTranscript, RecordingProvider, runAgent, typecheckFromEnv, type ModelProvider, type TypecheckFn } from '@pleatkit/agent'
import type { PleatkitManifest } from '@pleatkit/runtime/compiler'
import { BudgetExceededError, EvalBudget, gradeBudget } from './budget.js'
import { gradeRun, type RunResult } from './graders.js'
import { recordingFile } from './providers.js'
import { DEFAULT_TASK_BUDGET_USD, prepareTask, type PreparedTask } from './tasks.js'
import type { AgentKind, BrowserInvariants, EvalTask, GraderResult, PromptInfo, SuiteResult, TaskRun, Tokens } from './types.js'

/** What the browser grader needs of one run: the files to commit in the demo app and what to look for. */
export interface BrowserCase {
  taskId: string
  files: Record<string, string>
  deleted: string[]
  invariants: BrowserInvariants
}

/** Grades the browser invariants of several runs at once (one demo app, one headless browser). */
export type BrowserGrader = (cases: BrowserCase[]) => Promise<Record<string, GraderResult>>

export interface SuiteOptions {
  kind: SuiteResult['kind']
  agent: AgentKind
  tasks: EvalTask[]
  manifest: PleatkitManifest
  providerFor: (task: EvalTask, trial: number) => ModelProvider
  /** Runs per task (default 1): a number, or per task (a replay runs every transcript a set holds). */
  trials?: number | ((task: EvalTask) => number)
  /** Named set (`--set live`): its transcripts are `<task>.t<trial>.jsonl`; recorded in the result. */
  set?: string
  /** Run the cheap classifier first (default true, as the agent server does). */
  classify?: boolean
  /** The main model of a live run, recorded in the result. */
  model?: string
  budget?: EvalBudget
  /** tsc grader (PLEATKIT_TYPECHECK_ROOT); null skips it. */
  typecheck?: TypecheckFn | null
  /** Playwright grader; null skips it. */
  browser?: BrowserGrader | null
  /** Record every run into `<dir>/<taskId>.jsonl`, or `<taskId>.t<trial>.jsonl` in a named set (RecordingProvider). */
  recordDir?: string
  /** Transcript each run replays, for the report (replay runs). */
  recordingOf?: (task: EvalTask, trial: number) => string | null
  log?: (line: string) => void
}

/** The manifest's digests in the cached prefix, as the agent server passes them. */
type PromptDigests = NonNullable<Parameters<typeof buildPrompt>[2]>
export const digestsOf = (m: PleatkitManifest): PromptDigests => ({ ...(m.designSystem ? { designSystem: m.designSystem } : {}), ...(m.dataContracts ? { dataContracts: m.dataContracts } : {}) })

/** Size of the cached prompt prefix for the demo app: what a prompt change costs on every request. */
export function promptInfo(manifest: PleatkitManifest, sample: PreparedTask): PromptInfo {
  const parts = buildPrompt(sample.request, undefined, digestsOf(manifest))
  const prefixChars = parts.instructions.length + parts.cached.length
  return { version: PROMPT_VERSION, prefixChars, prefixTokens: Math.round(prefixChars / 3.5) }
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
  const startedAt = new Date().toISOString()
  const runs: TaskRun[] = []
  const prepared = o.tasks.map((t) => prepareTask(t, o.manifest))
  const trialsOf = (t: EvalTask): number => (typeof o.trials === 'function' ? o.trials(t) : (o.trials ?? 1))
  const numbered = o.set !== undefined || o.tasks.some((t) => trialsOf(t) > 1)
  const queue = prepared.flatMap((p) => Array.from({ length: trialsOf(p.task) }, (_, i) => ({ p, trial: i + 1 })))
  let aborted: SuiteResult['aborted']
  const results = new Map<string, RunResult>()
  const loopTypecheck = typecheckFromEnv(process.env)

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
      typecheck: loopTypecheck,
      digests: digestsOf(o.manifest),
      ...(o.classify === false ? { classify: false } : {}),
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
    const costUsd = result.usage.reduce((s, u) => s + (u.costUsd ?? 0), 0)
    budget.charge(costUsd)
    const graders = [...(await gradeRun(p, result, typecheck)), gradeBudget(costUsd, cap, result.stopReason, limit)]
    runs.push({
      taskId: task.id,
      ...(numbered ? { trial } : {}),
      title: task.title,
      agent: o.agent,
      expectedVerdict: task.expected.verdict,
      verdict: result.verdict,
      summary: result.summary,
      changedFiles: Object.keys(result.files),
      modelCalls: result.modelCalls,
      firstTry: firstTry(result),
      costUsd,
      unpricedModels: [...new Set(result.usage.filter((u) => u.costUsd === null && u.calls > 0).map((u) => u.model))],
      tokens: tokensOf(result),
      ...(provider.model ? { model: provider.model.replace(/^replay:/, '') } : {}),
      usage: result.usage,
      ms: result.timings.totalMs,
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
    const inv = o.tasks.find((t) => t.id === r.taskId)!.invariants?.browser
    const res = results.get(keyOf(r))!
    return inv ? [{ taskId: keyOf(r), files: res.files, deleted: res.deleted, invariants: inv }] : []
  })
  let browserResults: Record<string, GraderResult> = {}
  const browserRan = Boolean(o.browser && cases.length)
  if (o.browser && cases.length) {
    log(`browser: ${cases.length} case(s) in the demo app (headless)`)
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
    r.pass = r.graders.every((g) => g.pass)
  }

  return {
    kind: o.kind,
    startedAt,
    finishedAt: new Date().toISOString(),
    prompt: promptInfo(o.manifest, prepared[0] ?? prepareTask(o.tasks[0]!, o.manifest)),
    budget: { capUsd: budget.capUsd, spentUsd: budget.spentUsd },
    ...(aborted ? { aborted } : {}),
    browser: browserRan ? 'ran' : 'skipped',
    typecheck: typecheck ? 'ran' : 'skipped',
    ...(o.set !== undefined ? { set: o.set } : {}),
    ...(o.model ? { model: o.model } : {}),
    ...(o.classify === false ? { classifier: false } : {}),
    runs,
  }
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
