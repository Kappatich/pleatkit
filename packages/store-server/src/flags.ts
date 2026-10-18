import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'
import { flags } from './schema.js'

type Db = BetterSQLite3Database<typeof schema>

/**
 * F6. Flags the runtime and the agent server read. Defaults below; an app, an org or a single user can override
 * any of them (user over org over app). Unknown keys are passed through for the app's own use.
 * - `pleatkit.enabled`: the kill switch. `false`: everyone sees the original version, no chat, no agent runs.
 * - `edits.enabled`: `false` keeps users' versions but takes no new edits (the agent refuses, the chat says so).
 */
export const DEFAULT_FLAGS: Record<string, unknown> = { 'pleatkit.enabled': true, 'edits.enabled': true }

export type FlagScope = 'app' | 'org' | 'user'
export const FLAG_SCOPES: FlagScope[] = ['app', 'org', 'user']

export function resolveFlags(db: Db, appId: string, orgId: string, userId: string | null): Record<string, unknown> {
  const rows = db.select().from(flags).where(eq(flags.appId, appId)).all()
  const out: Record<string, unknown> = { ...DEFAULT_FLAGS }
  for (const scope of FLAG_SCOPES) {
    for (const r of rows) {
      if (r.scope !== scope) continue
      if (scope === 'org' && r.scopeId !== orgId) continue
      if (scope === 'user' && r.scopeId !== userId) continue
      out[r.key] = r.value
    }
  }
  return out
}

export function setFlag(db: Db, appId: string, scope: FlagScope, scopeId: string, key: string, value: unknown): void {
  const row = { appId, scope, scopeId: scope === 'app' ? '' : scopeId, key, value: value as never, updatedAt: new Date().toISOString() }
  db.insert(flags)
    .values(row)
    .onConflictDoUpdate({ target: [flags.appId, flags.scope, flags.scopeId, flags.key], set: { value: row.value, updatedAt: row.updatedAt } })
    .run()
}

export function deleteFlag(db: Db, appId: string, scope: FlagScope, scopeId: string, key: string): void {
  db.delete(flags)
    .where(and(eq(flags.appId, appId), eq(flags.scope, scope), eq(flags.scopeId, scope === 'app' ? '' : scopeId), eq(flags.key, key)))
    .run()
}

export function listFlags(db: Db, appId: string) {
  return db.select().from(flags).where(eq(flags.appId, appId)).all()
}
