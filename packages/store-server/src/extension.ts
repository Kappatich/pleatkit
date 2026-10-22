import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { Hono } from 'hono'
import type { Caller } from './auth.js'
import type { EventType } from './ledger.js'
import type * as schema from './schema.js'

export type StoreDb = BetterSQLite3Database<typeof schema>
/** Hono variables of every authenticated route: the caller resolved by the core. */
export type StoreEnv = { Variables: { caller: Caller } }

/**
 * DECISIONS 70.1 and 89: the store core is open (MIT): snapshots, heads, bundles, the request log with
 * approve/reject/rollback, the roles `user` and `admin`, quotas and plans, usage events, the audit chain, flags and
 * the kill switch, request labels, export and erasure. The pleatkit cloud adds its modules through this interface
 * (the private `@pleatkit/store-cloud`: the pilot report, the wish map, release carry-over runs, code search with
 * rollback by selection, the support role with acting as a user, the learning layer). The core runs without any
 * extension (self-host, the demo, examples/t1-vite); `createStoreApp(db, { extensions })` and the `pleatkit-store`
 * binary load them when present.
 */
export interface StoreExtension {
  name: string
  /**
   * Roles beyond the core's `user` and `admin` that this extension handles (the cloud's `support`). A token or demo
   * header with a role no loaded extension declares gets 403 `cloud-feature`.
   */
  roles?: string[]
  /**
   * Acting as another user (`x-pleatkit-act-as: <userId>`): return the caller acting as `target` (its `viewer` set to
   * who is acting), or throw `AuthError` to refuse. Without an extension that implements it, the header gets 403
   * `cloud-feature`. The first extension that implements it decides.
   */
  actAs?(who: Caller, target: string): Caller
  /** Whether a caller that is not an admin may use an /admin route (`path` without the `/v1` prefix). */
  adminAccess?(who: Caller, method: string, path: string): boolean
  /** Middleware on the authenticated API, registered right after the caller is resolved and before the core's routes. */
  middleware?(api: Hono<StoreEnv>, ctx: ExtensionContext): void
  /** Tables of the extension: plain idempotent DDL (`CREATE TABLE IF NOT EXISTS …`), run after the core schema. */
  ddl?: string
  /** One-off migrations after `ddl` (copying old rows, adding columns); must be idempotent. */
  migrate?(db: StoreDb): void
  /** Routes on the authenticated API (`/v1/...` and the unversioned prefix); `/admin/*` is already admin only (or what `adminAccess` allows). */
  routes?(api: Hono<StoreEnv>, ctx: ExtensionContext): void
  /** Periodic jobs; the `pleatkit-store` binary runs them hourly with the core's own (`runMaintenance`). */
  jobs?: { name: string; run(db: StoreDb, now: number): unknown }[]
  /** After `POST /v1/requests` logged an agent run. */
  onRequestLogged?(db: StoreDb, request: LoggedRequest): void
  /** An outcome of an agent edit: `alive24h`, `reverted:user`, `reverted:admin`. */
  onOutcome?(db: StoreDb, requestId: string, outcome: string): void
  /**
   * DECISIONS 70.2: delete the extension's rows of an erased user (`userId`) or app (`userId: null`). Runs inside
   * the erasure's transaction, before the core deletes the requests; returns how many rows per table.
   */
  erase?(db: StoreDb, subject: ErasureSubject): Record<string, number>
  /** Counted the same way as `erase`, without deleting (the confirm step). */
  count?(db: StoreDb, subject: ErasureSubject): Record<string, number>
  /** Extra fields of `GET /v1/admin/settings`. */
  settings?(db: StoreDb, appId: string): Record<string, unknown>
}

/** What an extension's routes may use. */
export interface ExtensionContext {
  db: StoreDb
  /** Append to the caller's app audit chain, with the caller as the actor (acting as a user names both ids). */
  audited(who: Caller, action: string, objectType: string, objectId: string | null, details?: Record<string, unknown> | null): string
  /** Region and environment recorded on rows written for this caller. */
  place(who: Caller): { region: string; environment: string }
  /** Append a usage event (F3) for the caller's app, as the core's own routes do. */
  event(who: Caller, type: EventType, userId: string | null, requestId: string | null, extra?: UsageEventExtra): void
  /** Report an outcome of an agent edit (`reverted:admin`, ...) to every extension's `onOutcome`. */
  outcome(requestId: string, label: string): void
  /** Move a user's head (no checks, no audit: the caller does both). */
  setHead(appId: string, userId: string, snapshotId: string, orgId?: string): void
}

/** Optional parts of a usage event written through `ExtensionContext.event`. */
export interface UsageEventExtra {
  value?: number
  unit?: string
  props?: Record<string, unknown>
  dedupeKey?: string
}

/** The agent run the core just logged, with the parts of the body an extension may read. */
export interface LoggedRequest {
  id: string
  appId: string
  orgId: string
  userId: string
  target: string | null
  verdict: string
  intentLabel: string | null
  usage: unknown[] | null
  log: unknown[]
  timings: Record<string, unknown> | null
  promptVersion: string | null
  model: string | null
  provider: string | null
  compilerVersion: string | null
}

/** Whose data an erasure removes: one user of an app, or the whole app (`userId: null`). */
export interface ErasureSubject {
  appId: string
  userId: string | null
}

/** The better-sqlite3 handle under a Drizzle database (for DDL and multi-statement SQL). */
export const rawDb = (db: StoreDb): Database.Database => (db as unknown as { $client: Database.Database }).$client

/** Create the extensions' tables and run their migrations (idempotent; `createStoreApp` calls it). */
export function attachExtensions(db: StoreDb, extensions: readonly StoreExtension[]): void {
  for (const ext of extensions) {
    if (ext.ddl) rawDb(db).exec(ext.ddl)
    ext.migrate?.(db)
  }
}
