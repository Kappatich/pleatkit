import { passRate } from './runner.js'
import type { Baseline, SuiteResult } from './types.js'

/** `pnpm eval:pin`: the current results become the baseline new runs are compared with. */
export function pinBaseline(s: SuiteResult, at = new Date()): Baseline {
  if (s.aborted) throw new Error(`Refusing to pin an aborted run (${s.aborted.reason})`)
  return {
    pinnedAt: at.toISOString(),
    promptVersion: s.prompt.version,
    prompt: s.prompt,
    passRate: passRate(s),
    tasks: Object.fromEntries(
      s.runs.map((r) => [r.taskId, { pass: r.pass, verdict: r.verdict, failed: r.graders.filter((g) => !g.pass).map((g) => g.grader), costUsd: r.costUsd, modelCalls: r.modelCalls }]),
    ),
  }
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

export function diffBaseline(s: SuiteResult, b: Baseline | null): BaselineDiff {
  const status: Record<string, DiffStatus> = {}
  for (const r of s.runs) {
    const was = b?.tasks[r.taskId]
    status[r.taskId] = !was ? 'new' : was.pass === r.pass ? (r.pass ? 'pass' : 'fail') : r.pass ? 'fixed' : 'regressed'
  }
  const ids = new Set(s.runs.map((r) => r.taskId))
  const notRun = new Set(s.aborted?.notRun ?? [])
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
