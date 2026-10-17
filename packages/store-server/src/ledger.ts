import { createHash } from 'node:crypto'
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'
import { audit, events, heads, requests, snapshots } from './schema.js'

type Db = BetterSQLite3Database<typeof schema>

/** Usage events (F3). Names are a public contract: add new ones, never rename. */
export const EVENT_TYPES = ['edit.requested', 'edit.applied', 'edit.reverted', 'edit.alive24h', 'editor.active', 'tokens.used', 'cost.usd'] as const
export type EventType = (typeof EVENT_TYPES)[number]

export interface UsageEvent {
  type: EventType
  value: number
  unit: string
  appId: string
  orgId: string
  userId: string | null
  requestId?: string | null
  source: 'agent' | 'store'
  /** Same key twice is stored once (retries, the daily `editor.active`). */
  dedupeKey?: string | null
  props?: Record<string, unknown> | null
  region: string
  environment: string
  tsMs?: number
}

/** Append one event; returns false when its dedupe key was already recorded. */
export function recordEvent(db: Db, e: UsageEvent): boolean {
  const tsMs = e.tsMs ?? Date.now()
  const r = db
    .insert(events)
    .values({
      ts: new Date(tsMs).toISOString(),
      tsMs,
      appId: e.appId,
      orgId: e.orgId,
      userId: e.userId,
      region: e.region,
      environment: e.environment,
      type: e.type,
      value: e.value,
      unit: e.unit,
      requestId: e.requestId ?? null,
      source: e.source,
      dedupeKey: e.dedupeKey ?? null,
      props: e.props ?? null,
    })
    .onConflictDoNothing()
    .run()
  return r.changes > 0
}

/** `editor.active` once per user per UTC day. */
export function markEditorActive(db: Db, e: Omit<UsageEvent, 'type' | 'value' | 'unit' | 'source' | 'dedupeKey'>): void {
  const day = new Date(e.tsMs ?? Date.now()).toISOString().slice(0, 10)
  recordEvent(db, { ...e, type: 'editor.active', value: 1, unit: 'editor', source: 'store', dedupeKey: `editor.active:${e.userId}:${day}` })
}

// --- audit (F7) ---

export interface AuditEntry {
  appId: string
  orgId: string
  actor: string
  action: string
  objectType: string
  objectId?: string | null
  details?: Record<string, unknown> | null
}

const GENESIS = 'genesis'

function canonical(e: { appId: string; orgId: string; ts: string; actor: string; action: string; objectType: string; objectId: string | null; details: unknown }): string {
  return JSON.stringify([e.appId, e.orgId, e.ts, e.actor, e.action, e.objectType, e.objectId, e.details ?? null])
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** Append to the app's audit chain: each row's hash covers its content and the previous row's hash. */
export function appendAudit(db: Db, e: AuditEntry): string {
  return db.transaction((tx) => {
    const last = tx.select({ hash: audit.hash }).from(audit).where(eq(audit.appId, e.appId)).orderBy(desc(audit.seq)).limit(1).get()
    const prevHash = last?.hash ?? GENESIS
    const ts = new Date().toISOString()
    const row = { appId: e.appId, orgId: e.orgId, ts, actor: e.actor, action: e.action, objectType: e.objectType, objectId: e.objectId ?? null, details: e.details ?? null }
    const hash = sha256(`${prevHash}\n${canonical(row)}`)
    tx.insert(audit)
      .values({ ...row, prevHash, hash })
      .run()
    return hash
  })
}

/** Recompute the chain of an app; `brokenAt` is the first row whose hash or link does not match. */
export function verifyAuditChain(db: Db, appId: string): { ok: boolean; rows: number; brokenAt: number | null } {
  const rows = db.select().from(audit).where(eq(audit.appId, appId)).orderBy(asc(audit.seq)).all()
  let prev = GENESIS
  for (const r of rows) {
    const expected = sha256(`${prev}\n${canonical({ ...r, objectId: r.objectId ?? null })}`)
    if (r.prevHash !== prev || r.hash !== expected) return { ok: false, rows: rows.length, brokenAt: r.seq }
    prev = r.hash
  }
  return { ok: true, rows: rows.length, brokenAt: null }
}

// --- edit.alive24h (F3) ---

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Emit `edit.alive24h` for applied edits older than 24 h that are still part of their user's current version
 * (the head is the edit's snapshot or a descendant of it). Idempotent: one event per request.
 */
export function sweepAlive24h(db: Db, place: { region: string; environment: string }, now = Date.now()): number {
  const candidates = db
    .select()
    .from(requests)
    .where(and(inArray(requests.status, ['applied', 'pending-review']), lt(requests.createdAtMs, now - DAY_MS)))
    .all()
  let emitted = 0
  for (const r of candidates) {
    if (!r.snapshotId) continue
    const head = db
      .select()
      .from(heads)
      .where(and(eq(heads.appId, r.appId), eq(heads.userId, r.userId)))
      .get()
    if (!head || !isAncestorOrSelf(db, r.appId, r.snapshotId, head.snapshotId)) continue
    const ok = recordEvent(db, {
      type: 'edit.alive24h',
      value: 1,
      unit: 'edit',
      appId: r.appId,
      orgId: r.orgId,
      userId: r.userId,
      requestId: r.id,
      source: 'store',
      dedupeKey: `edit.alive24h:${r.id}`,
      region: place.region,
      environment: r.environment ?? place.environment,
      tsMs: now,
    })
    if (ok) {
      emitted++
      // the outcome label of the L1 fact (DECISIONS 44); no-op when the app does not learn
      db.update(schema.requestFacts).set({ outcome: 'alive24h' }).where(eq(schema.requestFacts.requestId, r.id)).run()
    }
  }
  return emitted
}

function isAncestorOrSelf(db: Db, appId: string, ancestor: string, from: string): boolean {
  let id: string | null = from
  for (let i = 0; id && i < 500; i++) {
    if (id === ancestor) return true
    const s: { parentId: string | null } | undefined = db
      .select({ parentId: snapshots.parentId })
      .from(snapshots)
      .where(and(eq(snapshots.appId, appId), eq(snapshots.id, id)))
      .get()
    id = s?.parentId ?? null
  }
  return false
}
