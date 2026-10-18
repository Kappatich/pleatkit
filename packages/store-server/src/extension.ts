import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { Hono } from 'hono'
import type { Caller } from './auth.js'
import type * as schema from './schema.js'

export type StoreDb = BetterSQLite3Database<typeof schema>
/** Hono variables of every authenticated route: the caller resolved by the core. */
export type StoreEnv = { Variables: { caller: Caller } }

/**
 * DECISIONS 70.1: the store core is open (MIT); what only the managed cloud needs (the learning layer and its
 * `request_facts`, later billing and region routing) lives in a separate package and plugs in here. The core
 * runs without any extension (self-host, the demo, examples/t1-vite); `createStoreApp(db, { extensions })` and
 * the `pleatkit-store` binary load them when present.
 */
export interface StoreExtension {
  name: string
  /** Tables of the extension: plain idempotent DDL (`CREATE TABLE IF NOT EXISTS …`), run after the core schema. */
  ddl?: string
  /** One-off migrations after `ddl` (copying old rows, adding columns); must be idempotent. */
  migrate?(db: StoreDb): void
  /** Routes on the authenticated API (`/v1/...` and the unversioned prefix); `/admin/*` is already admin/support only. */
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
  /** Append to the caller's app audit chain, with the caller as the actor (an impersonation names both ids). */
  audited(who: Caller, action: string, objectType: string, objectId: string | null, details?: Record<string, unknown> | null): string
  /** Region and environment recorded on rows written for this caller. */
  place(who: Caller): { region: string; environment: string }
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
