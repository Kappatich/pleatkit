import { and, asc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'
import { appPlans, appSettings, audit, events, flags, heads, requestLabels, requests, snapshots } from './schema.js'

type Db = BetterSQLite3Database<typeof schema>

/** Version of the export document (F9). */
export const EXPORT_FORMAT = 1

/**
 * F9. Everything store-server keeps for one app, or for one user of it: snapshots (with files), heads, the request
 * log, usage events; for a whole app also its audit chain, flags, settings, plan and request labels. Bundles are left out: they
 * are derived from snapshots and are rebuilt on demand.
 */
export function buildExport(db: Db, appId: string, userId?: string | null) {
  const byUser = <T extends { userId: unknown }>(t: T) => (userId ? eq(t.userId as never, userId) : undefined)
  const where = <T extends { appId: unknown; userId: unknown }>(t: T) => and(eq(t.appId as never, appId), byUser(t))
  const doc = {
    format: EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    appId,
    userId: userId ?? null,
    snapshots: db.select().from(snapshots).where(where(snapshots)).orderBy(asc(snapshots.id)).all(),
    heads: db.select().from(heads).where(where(heads)).all(),
    requests: db.select().from(requests).where(where(requests)).orderBy(asc(requests.createdAtMs)).all(),
    events: db.select().from(events).where(where(events)).orderBy(asc(events.seq)).all(),
  }
  if (userId) return doc
  return {
    ...doc,
    audit: db.select().from(audit).where(eq(audit.appId, appId)).orderBy(asc(audit.seq)).all(),
    flags: db.select().from(flags).where(eq(flags.appId, appId)).all(),
    settings: db.select().from(appSettings).where(eq(appSettings.appId, appId)).get() ?? null,
    plan: db.select().from(appPlans).where(eq(appPlans.appId, appId)).get() ?? null,
    labels: db.select().from(requestLabels).where(eq(requestLabels.appId, appId)).orderBy(asc(requestLabels.updatedAtMs)).all(),
  }
}
