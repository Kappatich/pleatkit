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
  providerFor: (task: EvalTask) => ModelProvider
  budget?: EvalBudget
  /** tsc grader (PLEATKIT_TYPECHECK_ROOT); null skips it. */
  typecheck?: TypecheckFn | null
  /** Playwright grader; null skips it. */
  browser?: BrowserGrader | null
  /** Record every run into `<dir>/<taskId>.jsonl` (RecordingProvider). */
  recordDir?: string
  /** Transcript each task replays, for the report (replay runs). */
  recordingOf?: (task: EvalTask) => string | null
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

/**
 * Runs every task through the agent loop in-process (the same `runAgent`, tools, check and limits as the agent
 * server, with the server's trusted input from the demo's build manifest), grades each result, then grades the
 * browser invariants of all runs in one headless session. Money is enforced per task and for the whole run.
 */
export async function runSuite(o: SuiteOptions): Promise<SuiteResult> {
  const log = o.log ?? (() => undefined)
  const budget = o.budget ?? new EvalBudget(null)
  const typecheck = o.typecheck ?? null
  const startedAt = new Date().toISOString()
  const runs: TaskRun[] = []
  const prepared = o.tasks.map((t) => prepareTask(t, o.manifest))
  let aborted: SuiteResult['aborted']
  const results = new Map<string, RunResult>()
  const loopTypecheck = typecheckFromEnv(process.env)

  for (const [i, p] of prepared.entries()) {
    const task = p.task
    try {
      budget.admit(task.id, prepared.slice(i).map((x) => x.task.id))
    } catch (e) {
      if (!(e instanceof BudgetExceededError)) throw e
      aborted = { reason: e.message, notRun: prepared.slice(i).map((x) => x.task.id) }
      log(`ABORT ${e.message}`)
      break
    }
    const cap = task.budgetUsd ?? DEFAULT_TASK_BUDGET_USD
    const limit = budget.limitFor(cap)
    let provider = o.providerFor(task)
    let tmp: string | null = null
    if (o.recordDir) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-eval-rec-'))
      provider = new RecordingProvider(provider, { dir: tmp, taskId: task.id })
    }
    const result = await runAgent(p.request, provider, {
      limits: { maxCostUsd: limit },
      protected: p.trusted.protected,
      base: p.trusted.base,
      typecheck: loopTypecheck,
      digests: digestsOf(o.manifest),
    })
    let recording: TaskRun['recording']
    if (o.recordDir && tmp) {
      const written = (provider as RecordingProvider).files
      fs.mkdirSync(o.recordDir, { recursive: true })
      const dest = recordingFile(task.id, o.recordDir)
      if (written.length) {
        // one transcript per task: the classifier and the main loop of this run
        fs.writeFileSync(dest, written.map((f) => fs.readFileSync(f, 'utf8')).join(''))
        recording = { file: path.basename(dest), promptVersion: PROMPT_VERSION }
      }
      fs.rmSync(tmp, { recursive: true, force: true })
    } else {
      const file = o.recordingOf?.(task) ?? null
      if (file) recording = { file: path.basename(file), promptVersion: promptVersionOf(file) }
    }
    results.set(task.id, result)
    const costUsd = result.usage.reduce((s, u) => s + (u.costUsd ?? 0), 0)
    budget.charge(costUsd)
    const graders = [...(await gradeRun(p, result, typecheck)), gradeBudget(costUsd, cap, result.stopReason, limit)]
    runs.push({
      taskId: task.id,
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
      ms: result.timings.totalMs,
      ...(result.stopReason ? { stopReason: result.stopReason } : {}),
      graders,
      pass: false,
      ...(result.error ? { error: result.error } : {}),
      ...(recording ? { recording } : {}),
    })
    log(`${task.id}: ${result.verdict} (${graders.filter((g) => !g.pass).map((g) => g.grader).join(', ') || 'all in-process graders pass'})`)
  }

  const cases: BrowserCase[] = runs.flatMap((r) => {
    const inv = o.tasks.find((t) => t.id === r.taskId)!.invariants?.browser
    const res = results.get(r.taskId)!
    return inv ? [{ taskId: r.taskId, files: res.files, deleted: res.deleted, invariants: inv }] : []
  })
  let browserResults: Record<string, GraderResult> = {}
  const browserRan = Boolean(o.browser && cases.length)
  if (o.browser && cases.length) {
    log(`browser: ${cases.length} case(s) in the demo app (headless)`)
    browserResults = await o.browser(cases)
  }
  for (const r of runs) {
    const hasCase = cases.some((c) => c.taskId === r.taskId)
    r.graders.push(
      browserResults[r.taskId] ??
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
    runs,
  }
}

export const passRate = (s: Pick<SuiteResult, 'runs'>): number => (s.runs.length ? s.runs.filter((r) => r.pass).length / s.runs.length : 0)

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
