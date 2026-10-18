import { and, desc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'
import { heads, snapshots } from './schema.js'

type Db = BetterSQLite3Database<typeof schema>
type SnapshotRow = typeof snapshots.$inferSelect

/**
 * C11 (brainstorm 05 #17, the Sunday-night incident): find the users whose code contains a string, and take that
 * code away from all of them at once. The search reads the files of snapshots; the rollback moves each matching
 * head to the user's nearest earlier version without the string (their other edits stay).
 */
export interface GrepMatch {
  file: string
  line: number
  text: string
}

export interface GrepRow {
  userId: string
  orgId: string
  snapshotId: string
  isHead: boolean
  createdAt: string
  author: string
  message: string
  matches: GrepMatch[]
}

export const GREP_MIN = 2
export const GREP_MAX = 200
const MAX_MATCHES_PER_ROW = 5

export function grepError(grep: string | undefined): string | null {
  if (typeof grep !== 'string' || grep.length < GREP_MIN || grep.length > GREP_MAX) return `grep: ${GREP_MIN} to ${GREP_MAX} characters`
  return null
}

/** Lines of the snapshot's files that contain `needle` (plain text, case-sensitive). */
export function matchesOf(files: Record<string, string>, needle: string): GrepMatch[] {
  const out: GrepMatch[] = []
  for (const file of Object.keys(files).sort()) {
    const src = files[file]!
    if (!src.includes(needle)) continue
    src.split('\n').forEach((text, i) => {
      if (out.length < MAX_MATCHES_PER_ROW && text.includes(needle)) out.push({ file, line: i + 1, text: text.trim().slice(0, 240) })
    })
  }
  return out
}

const hasNeedle = (s: SnapshotRow, needle: string) => Object.values(s.files).some((src) => src.includes(needle))

/** Matching snapshots: by default only the live ones (each user's head), `all` for every version. */
export function grepSnapshots(db: Db, appId: string, needle: string, scope: 'heads' | 'all', limit = 200): { count: number; rows: GrepRow[] } {
  const headIds = new Map(
    db
      .select()
      .from(heads)
      .where(eq(heads.appId, appId))
      .all()
      .map((h) => [h.userId, h.snapshotId]),
  )
  let candidates: SnapshotRow[]
  if (scope === 'heads') {
    candidates = []
    for (const id of headIds.values()) {
      const s = db.select().from(snapshots).where(and(eq(snapshots.appId, appId), eq(snapshots.id, id))).get()
      if (s) candidates.push(s)
    }
  } else {
    candidates = db.select().from(snapshots).where(eq(snapshots.appId, appId)).orderBy(desc(snapshots.id)).all()
  }
  const rows: GrepRow[] = []
  let count = 0
  for (const s of candidates) {
    // the original version is the customer's own code: not something an admin rolls back
    if (!s.parentId || !hasNeedle(s, needle)) continue
    count++
    if (rows.length < limit) {
      rows.push({
        userId: s.userId,
        orgId: s.orgId,
        snapshotId: s.id,
        isHead: headIds.get(s.userId) === s.id,
        createdAt: s.createdAt,
        author: s.author,
        message: s.message,
        matches: matchesOf(s.files, needle),
      })
    }
  }
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.userId.localeCompare(b.userId))
  return { count, rows }
}

export interface SelectionRollback {
  userId: string
  from: string
  /** The nearest earlier version without the string; null when there is none (skipped). */
  to: string | null
  requestId: string | null
}

/**
 * Plan the rollback of every live version that contains `needle`: each head goes to its nearest ancestor whose
 * files do not contain it. Nothing changes here; `applySelectionRollback` moves the heads.
 */
export function planSelectionRollback(db: Db, appId: string, needle: string): SelectionRollback[] {
  const get = (id: string) => db.select().from(snapshots).where(and(eq(snapshots.appId, appId), eq(snapshots.id, id))).get()
  const plan: SelectionRollback[] = []
  for (const h of db.select().from(heads).where(eq(heads.appId, appId)).all()) {
    const head = get(h.snapshotId)
    if (!head?.parentId || !hasNeedle(head, needle)) continue
    let to: string | null = null
    let cur: SnapshotRow | undefined = head
    for (let i = 0; cur?.parentId && i < 500; i++) {
      cur = get(cur.parentId)
      if (cur && !hasNeedle(cur, needle)) {
        to = cur.id
        break
      }
    }
    plan.push({ userId: h.userId, from: head.id, to, requestId: head.requestId })
  }
  return plan.sort((a, b) => a.userId.localeCompare(b.userId))
}
