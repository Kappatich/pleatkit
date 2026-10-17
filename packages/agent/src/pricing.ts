import type { TokenUsage, UsageByModel } from '@morphkit/runtime/compiler'

/** USD per million tokens: input, output, cache read, cache write (5-minute TTL). */
interface Price {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

// Published first-party API prices (October 2026).
const PRICES: Record<string, Price> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
}

export function priceOf(model: string): Price | null {
  return PRICES[model] ?? null
}

export const emptyUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })

export function costUsd(model: string, u: TokenUsage): number | null {
  const p = priceOf(model)
  if (!p) return null
  return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) / 1_000_000
}

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
    if (u.thinkingTokens !== undefined) row.thinkingTokens = (row.thinkingTokens ?? 0) + u.thinkingTokens
    row.costUsd = costUsd(model, row)
    this.byModel.set(model, row)
  }

  rows(): UsageByModel[] {
    return [...this.byModel.values()]
  }
}
