import type { GraderResult } from './types.js'

/** The run is out of money: thrown by `EvalBudget.admit`, caught by the runner, which stops the suite. */
export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BudgetExceededError'
  }
}

const usd = (n: number) => `$${n.toFixed(n < 0.01 && n > 0 ? 4 : 2)}`

/** `MORPHKIT_EVAL_BUDGET_USD`: the global cap of one eval run in USD, or null (no cap). */
export function budgetFromEnv(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.MORPHKIT_EVAL_BUDGET_USD
  if (raw === undefined || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`MORPHKIT_EVAL_BUDGET_USD must be a positive number of dollars, got "${raw}"`)
  return n
}

/**
 * Money of one eval run (brainstorm 04 §8 item 3). Every task runs with a dollar limit of its own cap or what is left
 * of the global cap, whichever is smaller (the agent loop stops between model calls once it is reached, so one task
 * overshoots by at most one call). Once the global cap is spent, `admit` refuses the next task and the runner stops.
 */
export class EvalBudget {
  spentUsd = 0

  constructor(readonly capUsd: number | null) {}

  get leftUsd(): number {
    return this.capUsd === null ? Number.POSITIVE_INFINITY : Math.max(0, this.capUsd - this.spentUsd)
  }

  /** Throws when the global cap is spent; `notRun` are the tasks that will not run, for the message. */
  admit(taskId: string, notRun: string[] = [taskId]): void {
    if (this.capUsd !== null && this.spentUsd >= this.capUsd) {
      throw new BudgetExceededError(
        `Eval budget exhausted: ${usd(this.spentUsd)} spent of MORPHKIT_EVAL_BUDGET_USD=${usd(this.capUsd)}. Stopped before task ${taskId}; ${notRun.length} task(s) not run: ${notRun.join(', ')}. Raise the cap or run fewer tasks (--only).`,
      )
    }
  }

  /** The dollar limit of one task's agent run. */
  limitFor(taskCapUsd: number): number {
    return Math.min(taskCapUsd, this.leftUsd)
  }

  charge(costUsd: number): void {
    this.spentUsd += costUsd
  }
}

/** The per-task budget grader: the run stayed under the task's cap and was not stopped for money. */
export function gradeBudget(costUsd: number, taskCapUsd: number, stopReason: string | undefined, limitUsd: number): GraderResult {
  if (stopReason === 'cost') {
    const whose = limitUsd < taskCapUsd ? `what was left of MORPHKIT_EVAL_BUDGET_USD (${usd(limitUsd)})` : `the task cap of ${usd(taskCapUsd)}`
    return { grader: 'budget', pass: false, reason: `stopped by ${whose} after ${usd(costUsd)}` }
  }
  if (costUsd > taskCapUsd) return { grader: 'budget', pass: false, reason: `${usd(costUsd)} is over the task cap of ${usd(taskCapUsd)}` }
  return { grader: 'budget', pass: true, reason: `${usd(costUsd)} of ${usd(taskCapUsd)}` }
}
