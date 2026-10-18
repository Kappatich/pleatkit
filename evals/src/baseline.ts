import { passRate, taskPasses } from './runner.js'
import type { Baseline, SuiteResult, TaskRun } from './types.js'

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/**
 * `pnpm eval:pin`: the current results become the baseline new runs are compared with. A task that ran several
 * times (trials) gets one entry: `pass` when every trial passed, `passes` of `trials`, the most common verdict, the
 * graders that failed in any trial, the cost of all trials and the median of model calls.
 */
export function pinBaseline(s: SuiteResult, at = new Date()): Baseline {
  if (s.aborted) throw new Error(`Refusing to pin an aborted run (${s.aborted.reason})`)
  const byTask = new Map<string, TaskRun[]>()
  for (const r of s.runs) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r])
  const tasks: Baseline['tasks'] = {}
  for (const [id, runs] of byTask) {
    const passes = runs.filter((r) => r.pass).length
    const counts = new Map<string, number>()
    for (const r of runs) counts.set(String(r.verdict), (counts.get(String(r.verdict)) ?? 0) + 1)
    const verdict = runs.find((r) => String(r.verdict) === [...counts].sort((a, b) => b[1] - a[1])[0]![0])!.verdict
    tasks[id] = {
      pass: passes === runs.length,
      verdict,
      failed: [...new Set(runs.flatMap((r) => r.graders.filter((g) => !g.pass).map((g) => g.grader)))],
      costUsd: runs.reduce((t, r) => t + r.costUsd, 0),
      modelCalls: median(runs.map((r) => r.modelCalls)),
      ...(runs.length > 1 ? { passes, trials: runs.length } : {}),
    }
  }
  return { pinnedAt: at.toISOString(), promptVersion: s.prompt.version, prompt: s.prompt, passRate: passRate(s), tasks }
}

export type DiffStatus = 'pass' | 'fail' | 'fixed' | 'regressed' | 'new'

export interface BaselineDiff {
  status: Record<string, DiffStatus>
  regressions: string[]
  fixes: string[]
  added: string[]
  /** In the baseline, not in this run. */
  missing: string[]
  passRate: { now: number; baseline: number | null }
  prompt: { now: string; baseline: string | null; prefixTokensNow: number; prefixTokensBaseline: number | null }
  cost: { now: number; baseline: number | null }
}

/** Share of a baseline task's trials that passed (1 or 0 for a single run). */
const baseShare = (t: Baseline['tasks'][string]): number => (t.trials ? (t.passes ?? 0) / t.trials : t.pass ? 1 : 0)

/**
 * Per task: the share of its runs that pass now against the baseline's share. Lower is a regression, higher a fix;
 * equal is `pass` when every run passes, else `fail`. With one run per task this is the plain pass/fail diff.
 */
export function diffBaseline(s: SuiteResult, b: Baseline | null): BaselineDiff {
  const status: Record<string, DiffStatus> = {}
  for (const [id, t] of Object.entries(taskPasses(s))) {
    const was = b?.tasks[id]
    const now = t.passes / t.trials
    if (!was) status[id] = 'new'
    else {
      const before = baseShare(was)
      status[id] = now < before ? 'regressed' : now > before ? 'fixed' : now === 1 ? 'pass' : 'fail'
    }
  }
  const ids = new Set(s.runs.map((r) => r.taskId))
  const notRun = new Set((s.aborted?.notRun ?? []).map((k) => k.replace(/\.t\d+$/, '')))
  return {
    status,
    regressions: Object.keys(status).filter((k) => status[k] === 'regressed'),
    fixes: Object.keys(status).filter((k) => status[k] === 'fixed'),
    added: b ? Object.keys(status).filter((k) => status[k] === 'new') : [],
    missing: b ? Object.keys(b.tasks).filter((k) => !ids.has(k) && !notRun.has(k)) : [],
    passRate: { now: passRate(s), baseline: b ? b.passRate : null },
    prompt: { now: s.prompt.version, baseline: b ? b.promptVersion : null, prefixTokensNow: s.prompt.prefixTokens, prefixTokensBaseline: b ? b.prompt.prefixTokens : null },
    cost: { now: s.runs.reduce((t, r) => t + r.costUsd, 0), baseline: b ? Object.values(b.tasks).reduce((t, x) => t + x.costUsd, 0) : null },
  }
}
