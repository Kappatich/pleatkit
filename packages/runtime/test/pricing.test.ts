import { describe, expect, it } from 'vitest'
import { costUsd, MODEL_PRICES, priceOf } from '../src/compiler-entry.js'

describe('DECISIONS 75: the model price table lives in the runtime (agent, store-server and cli share it)', () => {
  it('prices every kind of token per million; an unknown model is unpriced', () => {
    expect(priceOf('claude-sonnet-5-5')).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 })
    expect(costUsd('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(2)
    expect(costUsd('claude-sonnet-5-5', { inputTokens: 4, outputTokens: 488, cacheReadTokens: 13_018, cacheWriteTokens: 10_340 })).toBeCloseTo(0.0333416, 7)
    expect(priceOf('gpt-x')).toBeNull()
    expect(priceOf('toString')).toBeNull()
    expect(costUsd('gpt-x', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull()
  })

  it('cache writes cost 1.25x input and cache reads 0.1x for every model in the table', () => {
    // block 6: Jev (TypeSafe) has no prompt cache and free output
    for (const p of Object.values(MODEL_PRICES).filter((x) => x.cacheWrite > 0)) {
      expect(p.cacheWrite).toBeCloseTo(p.input * 1.25, 10)
      expect(p.cacheRead).toBeLessThanOrEqual(p.input * 0.1 + 1e-9)
    }
  })
})
