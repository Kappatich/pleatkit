import { and, lt, sql } from 'drizzle-orm'
import type { StoreDb, StoreExtension } from './extension.js'
import { sweepAlive24h } from './ledger.js'
import { agentRuns, requests } from './schema.js'

export interface RetentionPolicy {
  /** Request text, target and gist kept this many days (L0). Default 90. */
  textDays: number
  /** Tool logs and proposed files (L0). Default 30. */
  logDays: number
}
export const DEFAULT_RETENTION: RetentionPolicy = { textDays: 90, logDays: 30 }

const DAY_MS = 86_400_000

/**
 * The core's retention job (DECISIONS 44): blank request text, targets and gists after `textDays`, tool logs and
 * the proposed files after `logDays`, and finished run records after a day. Snapshots live as long as the user's
 * history; deleting them is the erasure path (`DELETE /v1/admin/users/:id`, DECISIONS 70.2). Idempotent.
 */
export function applyRetention(db: StoreDb, now = Date.now(), policy: RetentionPolicy = DEFAULT_RETENTION): { text: number; logs: number; runs: number } {
  const text = db
    .update(requests)
    .set({ text: '', target: null, gist: null, retainedAt: new Date(now).toISOString() })
    .where(and(lt(requests.createdAtMs, now - policy.textDays * DAY_MS), sql`${requests.text} <> ''`))
    .run().changes
  const logs = db
    .update(requests)
    .set({ log: [], files: null })
    .where(and(lt(requests.createdAtMs, now - policy.logDays * DAY_MS), sql`${requests.log} <> '[]'`))
    .run().changes
  const runs = db.delete(agentRuns).where(lt(agentRuns.createdAtMs, now - DAY_MS)).run().changes
  return { text, logs, runs }
}

/**
 * Everything the store does on a timer (the binary runs it hourly): `edit.alive24h` (F3), the retention job, then
 * each extension's jobs. Returns what each step did; a failing extension job is reported, not thrown.
 */
export function runMaintenance(
  db: StoreDb,
  o: { region: string; environment: string; retention?: RetentionPolicy; extensions?: readonly StoreExtension[] },
  now = Date.now(),
): Record<string, unknown> {
  const extensions = o.extensions ?? []
  const out: Record<string, unknown> = {
    alive24h: sweepAlive24h(db, o, now, (requestId) => extensions.forEach((e) => e.onOutcome?.(db, requestId, 'alive24h'))),
    retention: applyRetention(db, now, o.retention),
  }
  for (const ext of extensions) {
    for (const job of ext.jobs ?? []) {
      try {
        out[`${ext.name}:${job.name}`] = job.run(db, now)
      } catch (e) {
        out[`${ext.name}:${job.name}`] = { error: (e as Error).message }
      }
    }
  }
  return out
}
