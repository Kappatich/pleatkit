// Token buckets for quotas (V1 A4), shared by the agent server's in-memory backend and store-server's SQLite
// backend. Pure functions: storage is somebody else's job, so a Redis backend is the same math.

/** One bucket: holds up to `capacity` tokens and refills `refillPerSec` tokens per second. */
export interface BucketSpec {
  key: string
  capacity: number
  refillPerSec: number
}

/**
 * One operation on a bucket:
 * - `take`: needs at least `amount` tokens, otherwise the whole batch is refused and nothing changes;
 * - `debit`: subtracts `amount` even below zero (a cost known only afterwards, e.g. dollars of a finished run);
 * - `peek`: needs more than zero tokens, changes nothing.
 */
export interface QuotaOp extends BucketSpec {
  op: 'take' | 'debit' | 'peek'
  amount?: number
}

export interface BucketState {
  tokens: number
  updatedMs: number
}

export interface QuotaOutcome {
  ok: boolean
  /** Key of the first bucket that refused. */
  refused?: string
  /** When the refusing bucket has enough tokens again, ms (null when it never refills). */
  retryAfterMs?: number | null
  /** Tokens per bucket after the batch (unchanged when refused). */
  tokens: Record<string, number>
}

/** Tokens of a bucket at `now`; a bucket never seen before starts full. */
export function refill(state: BucketState | undefined, spec: BucketSpec, now: number): number {
  if (!state) return spec.capacity
  const elapsed = Math.max(0, now - state.updatedMs) / 1000
  return Math.min(spec.capacity, state.tokens + elapsed * spec.refillPerSec)
}

/** Apply a batch atomically: either every take/peek passes and all ops apply, or nothing changes. */
export function applyQuotaOps(read: (key: string) => BucketState | undefined, ops: QuotaOp[], now: number): { outcome: QuotaOutcome; writes: Record<string, BucketState> } {
  const current: Record<string, number> = {}
  for (const op of ops) current[op.key] ??= refill(read(op.key), op, now)
  const next = { ...current }
  for (const op of ops) {
    const amount = op.amount ?? 1
    const have = next[op.key]!
    if ((op.op === 'take' && have < amount) || (op.op === 'peek' && have <= 0)) {
      const missing = op.op === 'take' ? amount - have : -have + 1e-9
      return {
        outcome: { ok: false, refused: op.key, retryAfterMs: op.refillPerSec > 0 ? Math.ceil((missing / op.refillPerSec) * 1000) : null, tokens: current },
        writes: {},
      }
    }
    if (op.op !== 'peek') next[op.key] = have - amount
  }
  const writes: Record<string, BucketState> = {}
  for (const key of Object.keys(next)) writes[key] = { tokens: next[key]!, updatedMs: now }
  return { outcome: { ok: true, tokens: next }, writes }
}

/** Per-day bucket: capacity `perDay`, refilled evenly over 24 hours. */
export const daily = (key: string, perDay: number): BucketSpec => ({ key, capacity: perDay, refillPerSec: perDay / 86_400 })
