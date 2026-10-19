import { costUsd } from '@pleatkit/runtime/compiler'
import type { TokenUsage, UsageByModel } from '@pleatkit/runtime/compiler'

// DECISIONS 75: the price table moved to the runtime, so store-server (the pilot report's money columns) and the cli
// (the expected cost of an edit) price tokens exactly as the agent does. Re-exported here for existing imports.
export { MODEL_PRICES, priceOf, costUsd, type ModelPrice } from '@pleatkit/runtime/compiler'

export const emptyUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })

/**
 * Share of the main model's input that came from the prompt cache (brainstorm 04 §5): cache reads over all input
 * (uncached + cache writes + cache reads). The eval harness treats a run below 0.8 as a broken prefix.
 */
export function cacheHitRate(rows: Pick<UsageByModel, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'calls'>[]): number | null {
  const main = rows.filter((r) => r.calls > 0)
  const total = main.reduce((s, r) => s + r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens, 0)
  return total > 0 ? main.reduce((s, r) => s + r.cacheReadTokens, 0) / total : null
}

/** Accumulates usage per model across the classifier and the main loop. */
export class UsageMeter {
  private byModel = new Map<string, UsageByModel>()

  add(model: string, u: TokenUsage): void {
    const row = this.byModel.get(model) ?? { model, calls: 0, costUsd: null, ...emptyUsage() }
    row.calls++
    row.inputTokens += u.inputTokens
    row.outputTokens += u.outputTokens
    row.cacheReadTokens += u.cacheReadTokens
    row.cacheWriteTokens += u.cacheWriteTokens
    if (u.cacheWrite1hTokens) row.cacheWrite1hTokens = (row.cacheWrite1hTokens ?? 0) + u.cacheWrite1hTokens
    if (u.thinkingTokens !== undefined) row.thinkingTokens = (row.thinkingTokens ?? 0) + u.thinkingTokens
    row.costUsd = costUsd(model, row)
    this.byModel.set(model, row)
  }

  rows(): UsageByModel[] {
    return [...this.byModel.values()]
  }
}
