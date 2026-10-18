import { cacheHitRate } from '@pleatkit/agent'
import { graderRates, taskPasses } from './runner.js'
import type { SuiteResult, TaskRun } from './types.js'

export const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** Nearest-rank percentile (p in 0..100): the smallest value with at least p % of the values at or below it. */
export const percentile = (xs: number[], p: number): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!
}

export interface TaskSeries {
  taskId: string
  title: string
  expected: string
  passes: number
  trials: number
  verdicts: string[]
  medianCalls: number
  medianMs: number
  medianCostUsd: number
}

/** The numbers of one series (stage 5): per task over its trials, per grader, and the run-level distributions. */
export interface SeriesMetrics {
  runs: number
  passed: number
  /** Tasks whose every trial passed, of all tasks. */
  tasksAllPass: number
  tasks: TaskSeries[]
  graders: Record<string, { pass: number; total: number }>
  /** Runs that wrote files and needed no second attempt (no failed check or finish), of the runs that wrote files. */
  firstTry: { yes: number; of: number }
  /** Main-loop model calls over runs that reached the main model (classifier-only answers have 0). */
  modelCalls: { median: number; total: number; runs: number }
  /** Wall time of every run, send to result (the record of a live run; a replay's timings are not model latency). */
  latencyMs: { median: number; p90: number; max: number }
  /** Cost of every request, and of the requests that changed files (an edit). */
  costPerRequest: { median: number; max: number; total: number }
  costPerEdit: { median: number; max: number; runs: number }
  /** `cacheHitRate()` of the agent over the usage rows of every run (classifier included). */
  cacheHitRate: number | null
  /** The same over the runs that reached the main model, main-loop rows only (the classifier has no cached prefix). */
  mainCacheHitRate: number | null
}

const rowsOf = (r: TaskRun) => r.usage ?? []

export function seriesMetrics(s: Pick<SuiteResult, 'runs'>): SeriesMetrics {
  const tp = taskPasses(s)
  const tasks: TaskSeries[] = Object.entries(tp).map(([id, t]) => {
    const runs = s.runs.filter((r) => r.taskId === id)
    return {
      taskId: id,
      title: runs[0]!.title,
      expected: runs[0]!.expectedVerdict,
      passes: t.passes,
      trials: t.trials,
      verdicts: runs.map((r) => String(r.verdict)),
      medianCalls: median(runs.map((r) => r.modelCalls)),
      medianMs: median(runs.map((r) => r.ms)),
      medianCostUsd: median(runs.map((r) => r.costUsd)),
    }
  })
  const wrote = s.runs.filter((r) => r.firstTry !== null)
  const main = s.runs.filter((r) => r.modelCalls > 0)
  const edits = s.runs.filter((r) => r.changedFiles.length > 0)
  const ms = s.runs.map((r) => r.ms)
  const costs = s.runs.map((r) => r.costUsd)
  // the main model's rows (when the classifier is the same model, its call is in that row too)
  const mainRows = main.flatMap((r) => rowsOf(r).filter((u) => !r.model || u.model === r.model))
  return {
    runs: s.runs.length,
    passed: s.runs.filter((r) => r.pass).length,
    tasksAllPass: tasks.filter((t) => t.passes === t.trials).length,
    tasks,
    graders: graderRates(s),
    firstTry: { yes: wrote.filter((r) => r.firstTry).length, of: wrote.length },
    modelCalls: { median: median(main.map((r) => r.modelCalls)), total: s.runs.reduce((t, r) => t + r.modelCalls, 0), runs: main.length },
    latencyMs: { median: median(ms), p90: percentile(ms, 90), max: ms.length ? Math.max(...ms) : 0 },
    costPerRequest: { median: median(costs), max: costs.length ? Math.max(...costs) : 0, total: costs.reduce((a, b) => a + b, 0) },
    costPerEdit: { median: median(edits.map((r) => r.costUsd)), max: edits.length ? Math.max(...edits.map((r) => r.costUsd)) : 0, runs: edits.length },
    cacheHitRate: cacheHitRate(s.runs.flatMap(rowsOf)),
    mainCacheHitRate: cacheHitRate(mainRows),
  }
}
