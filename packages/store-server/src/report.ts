import { and, eq, gte, inArray, lt } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'
import { events, requests, snapshots } from './schema.js'

type Db = BetterSQLite3Database<typeof schema>

/**
 * C9: the pilot report, one row per day and customer organization, plus a total. What was asked (requests by
 * verdict), what happened to the edits (applied, undone by the user, rolled back by an admin, still live after
 * 24 hours), what carried over to new releases, and what it cost. `GET /v1/report?from&to` (CSV or JSON).
 */
export const REPORT_COLUMNS = [
  'date',
  'org',
  'orgs',
  'users',
  'requests',
  'ok',
  'partial',
  'needs_backend',
  'out_of_zone',
  'clarify',
  'declined',
  'refused',
  'failed',
  'applied',
  'reverted_by_user',
  'rolled_back_by_admin',
  'alive_24h',
  'carry_overs',
  'cost_usd',
] as const

export type ReportColumn = (typeof REPORT_COLUMNS)[number]
export type ReportRow = Record<ReportColumn, string | number>

const VERDICT_COLUMN: Record<string, ReportColumn> = {
  ok: 'ok',
  partial: 'partial',
  'needs-backend': 'needs_backend',
  'not-editable': 'out_of_zone',
  clarify: 'clarify',
  declined: 'declined',
  refused: 'refused',
  failed: 'failed',
}

/** Message of the snapshot a carry-over makes (the runtime's by itself, `pleatkit carry-over` by the agent). */
export const CARRY_OVER_PREFIX = 'Carried over'

const DAY_MS = 24 * 60 * 60 * 1000
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** `YYYY-MM-DD` (inclusive) or a millisecond timestamp; `to` as a date means the end of that day. */
export function parseRange(from: string | undefined, to: string | undefined, now = Date.now()): { fromMs: number; toMs: number } | { error: string } {
  const parse = (v: string, end: boolean): number | null => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const ms = Date.parse(`${v}T00:00:00.000Z`)
      return Number.isNaN(ms) ? null : end ? ms + DAY_MS : ms
    }
    return /^\d{10,14}$/.test(v) ? Number(v) : null
  }
  const toMs = to ? parse(to, true) : now
  const fromMs = from ? parse(from, false) : (toMs ?? now) - 7 * DAY_MS
  if (fromMs === null || toMs === null) return { error: 'from and to must be YYYY-MM-DD dates (or millisecond timestamps)' }
  if (toMs <= fromMs) return { error: 'to must be after from' }
  if (toMs - fromMs > 400 * DAY_MS) return { error: 'the range is at most 400 days' }
  return { fromMs, toMs }
}

const blank = (date: string, org: string): ReportRow =>
  Object.fromEntries(REPORT_COLUMNS.map((c) => [c, c === 'date' ? date : c === 'org' ? org : 0])) as ReportRow

const costOf = (usage: unknown): number =>
  Array.isArray(usage) ? usage.reduce((s: number, u: { costUsd?: unknown }) => s + (typeof u?.costUsd === 'number' ? u.costUsd : 0), 0) : 0

export interface Report {
  appId: string
  from: string
  to: string
  rows: ReportRow[]
  total: ReportRow
}

export function buildReport(db: Db, appId: string, fromMs: number, toMs: number): Report {
  const reqs = db
    .select()
    .from(requests)
    .where(and(eq(requests.appId, appId), gte(requests.createdAtMs, fromMs), lt(requests.createdAtMs, toMs)))
    .all()
  const ids = reqs.map((r) => r.id)
  // outcomes come from the usage ledger (F3), whenever they happened: the report is about the requests of the range
  const outcome = new Map<string, Set<string>>()
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const evs = db
      .select({ type: events.type, requestId: events.requestId, props: events.props })
      .from(events)
      .where(and(eq(events.appId, appId), inArray(events.requestId, chunk), inArray(events.type, ['edit.reverted', 'edit.alive24h'])))
      .all()
    for (const e of evs) {
      const key = e.type === 'edit.alive24h' ? 'alive_24h' : (e.props as { by?: string } | null)?.by === 'admin' ? 'rolled_back_by_admin' : 'reverted_by_user'
      const set = outcome.get(e.requestId!) ?? new Set<string>()
      set.add(key)
      outcome.set(e.requestId!, set)
    }
  }
  const carried = db
    .select({ orgId: snapshots.orgId, createdAt: snapshots.createdAt, message: snapshots.message })
    .from(snapshots)
    .where(and(eq(snapshots.appId, appId), gte(snapshots.createdAt, new Date(fromMs).toISOString()), lt(snapshots.createdAt, new Date(toMs).toISOString())))
    .all()
    .filter((s) => s.message.startsWith(CARRY_OVER_PREFIX))

  const rows = new Map<string, ReportRow>()
  const users = new Map<string, Set<string>>()
  const row = (date: string, org: string) => {
    const k = `${date}\0${org}`
    let r = rows.get(k)
    if (!r) rows.set(k, (r = blank(date, org)))
    return r
  }
  const inc = (r: ReportRow, c: ReportColumn, by = 1) => (r[c] = (r[c] as number) + by)
  const total = blank('total', 'all')
  const allUsers = new Set<string>()
  const allOrgs = new Set<string>()
  for (const q of reqs) {
    const date = dayOf(q.createdAtMs)
    const r = row(date, q.orgId)
    for (const target of [r, total]) {
      inc(target, 'requests')
      inc(target, VERDICT_COLUMN[q.verdict] ?? 'failed')
      if (q.snapshotId) inc(target, 'applied')
      for (const o of outcome.get(q.id) ?? []) inc(target, o as ReportColumn)
      inc(target, 'cost_usd', costOf(q.usage))
    }
    const k = `${date}\0${q.orgId}`
    users.set(k, (users.get(k) ?? new Set()).add(q.userId))
    allUsers.add(`${q.orgId}\0${q.userId}`)
    allOrgs.add(q.orgId)
  }
  for (const s of carried) {
    inc(row(s.createdAt.slice(0, 10), s.orgId), 'carry_overs')
    inc(total, 'carry_overs')
    allOrgs.add(s.orgId)
  }
  const out = [...rows.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.org).localeCompare(String(b.org)))
  for (const r of out) {
    r.orgs = 1
    r.users = users.get(`${r.date}\0${r.org}`)?.size ?? 0
    r.cost_usd = Number((r.cost_usd as number).toFixed(4))
  }
  total.orgs = allOrgs.size
  total.users = allUsers.size
  total.cost_usd = Number((total.cost_usd as number).toFixed(4))
  return { appId, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), rows: out, total }
}

/** RFC 4180: quote a field that has a comma, a quote or a line break; a leading `=+-@` is defused for spreadsheets. */
export function csvField(v: string | number): string {
  let s = String(v)
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function reportCsv(r: Report): string {
  const lines = [REPORT_COLUMNS.join(',')]
  for (const row of [...r.rows, r.total]) lines.push(REPORT_COLUMNS.map((c) => csvField(row[c])).join(','))
  return lines.join('\r\n') + '\r\n'
}
