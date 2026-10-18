import { applyQuotaOps, daily, type BucketState, type QuotaOp, type QuotaOutcome } from '@pleatkit/runtime/compiler'
import type { Identity } from './auth.js'
import type { StoreClient } from './store-client.js'

/**
 * Limits of an app. Values are data (F14): the default plan below, overridden per app in store-server
 * (`PUT /v1/admin/plan`) or, without a store, by PLEATKIT_PLAN / PLEATKIT_LIMITS.
 */
export interface PlanLimits {
  /** Model cost of one edit, USD: the run stops when it is reached. */
  perEditUsd: number
  /** Per user per day (rolling, refilled evenly over 24 h). */
  userDailyUsd: number
  userDailyEdits: number
  /** Per app per day. */
  appDailyUsd: number
  appDailyEdits: number
  /** Server compiles per user per day (V1 B1; cheap, but not free). */
  userDailyCompiles: number
}

/** Named plans. A managed (cloud) deployment bills per edit, not per token (DECISIONS 23). */
export const PLANS: Record<string, PlanLimits> = {
  free: { perEditUsd: 0.3, userDailyUsd: 1, userDailyEdits: 30, appDailyUsd: 10, appDailyEdits: 300, userDailyCompiles: 500 },
  team: { perEditUsd: 0.5, userDailyUsd: 3, userDailyEdits: 100, appDailyUsd: 100, appDailyEdits: 3000, userDailyCompiles: 2000 },
  unlimited: { perEditUsd: 5, userDailyUsd: 1e9, userDailyEdits: 1e9, appDailyUsd: 1e9, appDailyEdits: 1e9, userDailyCompiles: 1e9 },
}
export const DEFAULT_PLAN = 'free'

/** Default plan merged with overrides, unknown keys and bad values ignored. */
export function resolvePlan(name: string | null | undefined, overrides: Record<string, unknown> = {}): PlanLimits {
  const base = PLANS[name ?? ''] ?? PLANS[DEFAULT_PLAN]!
  const out = { ...base }
  for (const k of Object.keys(base) as (keyof PlanLimits)[]) {
    const v = overrides[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v
  }
  return out
}

/** Where buckets live: in this process, or in store-server's SQLite (same math; a Redis backend fits here). */
export interface QuotaBackend {
  apply(appId: string, ops: QuotaOp[]): Promise<QuotaOutcome>
}

export class MemoryQuotaBackend implements QuotaBackend {
  private readonly buckets = new Map<string, BucketState>()

  async apply(appId: string, ops: QuotaOp[]): Promise<QuotaOutcome> {
    const { outcome, writes } = applyQuotaOps((k) => this.buckets.get(`${appId}\0${k}`), ops, Date.now())
    for (const [k, v] of Object.entries(writes)) this.buckets.set(`${appId}\0${k}`, v)
    return outcome
  }
}

export class StoreQuotaBackend implements QuotaBackend {
  constructor(private readonly store: StoreClient) {}
  apply(appId: string, ops: QuotaOp[]): Promise<QuotaOutcome> {
    return this.store.quota(appId, ops)
  }
}

export interface QuotaDecision {
  ok: boolean
  /** Which limit refused: `user-edits`, `user-usd`, `app-edits`, `app-usd`, `user-compiles`. */
  limit?: string
  retryAfterMs?: number | null
  plan: PlanLimits
}

const LIMIT_OF: Record<string, string> = { 'user-edits': 'userDailyEdits', 'user-usd': 'userDailyUsd', 'app-edits': 'appDailyEdits', 'app-usd': 'appDailyUsd', 'user-compiles': 'userDailyCompiles' }

/**
 * The quota policy (V1 A4): before a run, one edit is taken from the user's and the app's daily edit buckets
 * and both dollar buckets must still have something left; after the run its cost is debited (it may go below
 * zero, which blocks further edits until the bucket refills). The cost of one edit is capped by `perEditUsd`.
 */
export class Quotas {
  private planCache = new Map<string, { plan: PlanLimits; at: number }>()

  constructor(
    private readonly backend: QuotaBackend,
    private readonly loadPlan: (appId: string) => Promise<PlanLimits>,
    private readonly planTtlMs = 60_000,
  ) {}

  async plan(appId: string): Promise<PlanLimits> {
    const hit = this.planCache.get(appId)
    if (hit && Date.now() - hit.at < this.planTtlMs) return hit.plan
    const plan = await this.loadPlan(appId)
    this.planCache.set(appId, { plan, at: Date.now() })
    return plan
  }

  private buckets(who: Identity, plan: PlanLimits) {
    return {
      userEdits: daily(`user:${who.userId}:edits`, plan.userDailyEdits),
      userUsd: daily(`user:${who.userId}:usd`, plan.userDailyUsd),
      appEdits: daily('app:edits', plan.appDailyEdits),
      appUsd: daily('app:usd', plan.appDailyUsd),
      userCompiles: daily(`user:${who.userId}:compiles`, plan.userDailyCompiles),
    }
  }

  private decide(outcome: QuotaOutcome, plan: PlanLimits, names: Record<string, string>): QuotaDecision {
    if (outcome.ok) return { ok: true, plan }
    return { ok: false, limit: names[outcome.refused ?? ''] ?? 'quota', retryAfterMs: outcome.retryAfterMs ?? null, plan }
  }

  async beforeEdit(who: Identity): Promise<QuotaDecision> {
    const plan = await this.plan(who.appId)
    const b = this.buckets(who, plan)
    const outcome = await this.backend.apply(who.appId, [
      { ...b.userUsd, op: 'peek' },
      { ...b.appUsd, op: 'peek' },
      { ...b.userEdits, op: 'take' },
      { ...b.appEdits, op: 'take' },
    ])
    return this.decide(outcome, plan, { [b.userEdits.key]: 'user-edits', [b.userUsd.key]: 'user-usd', [b.appEdits.key]: 'app-edits', [b.appUsd.key]: 'app-usd' })
  }

  /**
   * Debit the run's cost. Returns how much of the daily dollar budgets is used now (for the 50/80/100 % alerts
   * and the freeze of one user, brainstorm 05 #5).
   */
  async afterEdit(who: Identity, costUsd: number): Promise<{ appUsd: number | null; userShareOfApp: number | null }> {
    const plan = await this.plan(who.appId)
    const b = this.buckets(who, plan)
    const op = costUsd > 0 ? ('debit' as const) : ('peek' as const)
    const out = await this.backend.apply(who.appId, [
      { ...b.userUsd, op, amount: costUsd },
      { ...b.appUsd, op, amount: costUsd },
    ])
    const used = (key: string, capacity: number) => (capacity > 0 && typeof out.tokens[key] === 'number' ? (capacity - out.tokens[key]!) / capacity : null)
    const userUsed = used(b.userUsd.key, plan.userDailyUsd)
    return {
      appUsd: used(b.appUsd.key, plan.appDailyUsd),
      userShareOfApp: userUsed === null || plan.appDailyUsd <= 0 ? null : (userUsed * plan.userDailyUsd) / plan.appDailyUsd,
    }
  }

  async beforeCompile(who: Identity): Promise<QuotaDecision> {
    const plan = await this.plan(who.appId)
    const b = this.buckets(who, plan)
    return this.decide(await this.backend.apply(who.appId, [{ ...b.userCompiles, op: 'take' }]), plan, { [b.userCompiles.key]: 'user-compiles' })
  }

  /** The plan field behind a refused limit (for logs). */
  static limitField(limit: string | undefined): string | undefined {
    return limit ? LIMIT_OF[limit] : undefined
  }
}
