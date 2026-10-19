import type { TokenUsage } from './protocol.js'

/** USD per million tokens: input, output, cache read, cache write (5-minute TTL). */
export interface ModelPrice {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * Published first-party API prices (October 2026). One table for the agent server (the cost of a run), store-server
 * (the money columns of the pilot report, DECISIONS 75 Р4) and `pleatkit doctor` (the expected cost of an edit, Р2).
 * A model that is not here is "unpriced": its tokens are counted but carry no dollar amount.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // DECISIONS 83: TypeSafe's Jev (System One) as the classifier ensemble's first opinion; output is not billed
  'jev-latest': { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
}

export function priceOf(model: string): ModelPrice | null {
  if (Object.prototype.hasOwnProperty.call(MODEL_PRICES, model)) return MODEL_PRICES[model]!
  // the API answers with the pinned version (jev-1.13.0) for jev-latest
  return /^jev-\d/.test(model) ? MODEL_PRICES['jev-latest']! : null
}

/** Cost of the tokens in USD by the table above; `null` for a model the table does not know. */
export function costUsd(model: string, u: Pick<TokenUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'cacheWrite1hTokens'>): number | null {
  const p = priceOf(model)
  if (!p) return null
  // block 6: 1-hour cache writes cost 2× the input price, the 5-minute ones `cacheWrite` (1.25×)
  const write1h = Math.min(u.cacheWrite1hTokens ?? 0, u.cacheWriteTokens)
  return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite + write1h * (2 * p.input - p.cacheWrite)) / 1_000_000
}
