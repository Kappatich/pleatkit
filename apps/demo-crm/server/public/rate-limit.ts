import { createHash, randomBytes } from 'node:crypto'
import { today } from './budget.js'

/** Requests allowed per window, per client (IP hash) and route class. */
export const LIMITS = {
  page: { max: 240, windowMs: 60_000 },
  status: { max: 120, windowMs: 60_000 },
  data: { max: 240, windowMs: 60_000 },
  store: { max: 240, windowMs: 60_000 },
  bundle: { max: 240, windowMs: 60_000 },
  run: { max: 12, windowMs: 60_000 },
  agent: { max: 60, windowMs: 60_000 },
  event: { max: 60, windowMs: 60_000 },
  lead: { max: 5, windowMs: 3_600_000 },
  newVisitor: { max: 30, windowMs: 3_600_000 },
} as const

export type LimitClass = keyof typeof LIMITS

/**
 * Fixed-window counters in memory. Clients are keyed by a hash of their address with a salt that changes every UTC
 * day and never leaves the process, so nothing here can be turned back into an IP, and nothing is written to disk.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>()
  private salt = { day: '', value: '' }

  /** @param scale multiplies every limit (DEMO_RATE_SCALE; the demo's own tests run many visitors from one address). */
  constructor(private readonly scale = 1) {}

  /** sha256(daily salt + address), 16 hex. */
  clientKey(address: string): string {
    const d = today()
    if (this.salt.day !== d) this.salt = { day: d, value: randomBytes(16).toString('hex') }
    return createHash('sha256').update(this.salt.value).update(address).digest('hex').slice(0, 16)
  }

  /** True when this request is within the limit (and counts it); false means answer 429. */
  take(client: string, cls: LimitClass): { ok: boolean; retryAfterS: number } {
    const { max, windowMs } = LIMITS[cls]
    const k = `${cls}\0${client}`
    const now = Date.now()
    let w = this.windows.get(k)
    if (!w || now - w.start >= windowMs) {
      w = { start: now, count: 0 }
      this.windows.set(k, w)
    }
    w.count++
    if (this.windows.size > 50_000) this.prune()
    return { ok: w.count <= max * this.scale, retryAfterS: Math.ceil((w.start + windowMs - now) / 1000) }
  }

  prune(): void {
    const now = Date.now()
    for (const [k, w] of this.windows) {
      const cls = k.slice(0, k.indexOf('\0')) as LimitClass
      if (now - w.start >= LIMITS[cls].windowMs) this.windows.delete(k)
    }
  }
}
