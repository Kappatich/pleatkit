import { and, eq, gte, inArray, lt } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { costUsd } from '@pleatkit/runtime/compiler'
import * as schema from './schema.js'
import { events, requests, snapshots } from './schema.js'

type Db = BetterSQLite3Database<typeof schema>

/**
 * C9: the pilot report, one row per day and customer organization, then one row per organization over the whole
 * range (`date` = `all`), then the total (`date` = `total`, `org` = `all`). What was asked (requests by verdict),
 * what happened to the edits (applied, undone by the user, rolled back by an admin, still live after 24 hours), what
 * carried over to new releases, and what it cost. `GET /v1/report?from&to[&minutesPerEdit][&format=json]`.
 *
 * Money (DECISIONS 75, brainstorm 16 Р4), appended after the old columns so existing CSV readers keep working:
 * - `cost_usd`: the agent's own cost of the requests of the range (their logged usage), as before;
 * - `token_cost_usd`: the metering ledger's `tokens.used` events of the range priced by the model price table of
 *   @pleatkit/runtime (the same table the agent uses), by the day and organization of the event;
 * - `unpriced_tokens`: tokens of `tokens.used` events whose model the price table does not know (not in
 *   `token_cost_usd`; the JSON lists the models in `unpricedModels`);
 * - `dev_hours_saved`: applied edits × minutes per edit / 60, rounded to 0.1 h (minutes per edit: the
 *   `minutesPerEdit` query parameter, else store-server's `PLEATKIT_REPORT_MINUTES_PER_EDIT`, else 20);
 * - `cost_per_applied_edit_usd`: `token_cost_usd` / `applied`; empty when nothing was applied.
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
  'token_cost_usd',
  'unpriced_tokens',
  'dev_hours_saved',
  'cost_per_applied_edit_usd',
] as const

export type ReportColumn = (typeof REPORT_COLUMNS)[number]
/** A cell: a number, the date or org label, or null (CSV: empty) for a ratio without a denominator. */
export type ReportRow = Record<ReportColumn, string | number | null>

/** Brainstorm 16 part 2 item 6: what one applied edit saves a developer, minutes (a ticket, a change, a review). */
export const DEFAULT_MINUTES_PER_EDIT = 20
/** The most a `minutesPerEdit` may say (a working day). */
export const MAX_MINUTES_PER_EDIT = 480

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

/** A `minutesPerEdit` value (query parameter or environment): a number above 0 and at most 480. */
export function parseMinutesPerEdit(v: string | undefined | null): number | null {
  if (v === undefined || v === null || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 && n <= MAX_MINUTES_PER_EDIT ? n : null
}

const blank = (date: string, org: string): ReportRow =>
  Object.fromEntries(REPORT_COLUMNS.map((c) => [c, c === 'date' ? date : c === 'org' ? org : 0])) as ReportRow

const costOf = (usage: unknown): number =>
  Array.isArray(usage) ? usage.reduce((s: number, u: { costUsd?: unknown }) => s + (typeof u?.costUsd === 'number' ? u.costUsd : 0), 0) : 0

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export interface Report {
  appId: string
  from: string
  to: string
  /** The minutes per applied edit behind `dev_hours_saved`. */
  minutesPerEdit: number
  /** Per day and organization. */
  rows: ReportRow[]
  /** Per organization over the whole range (`date` = `all`). */
  orgs: ReportRow[]
  total: ReportRow
  /** Models of `tokens.used` events the price table does not know (their tokens are in `unpriced_tokens`). */
  unpricedModels: string[]
}

export interface ReportOptions {
  /** Minutes one applied edit saves a developer (default 20). */
  minutesPerEdit?: number
}

export function buildReport(db: Db, appId: string, fromMs: number, toMs: number, options: ReportOptions = {}): Report {
  const minutesPerEdit = options.minutesPerEdit ?? DEFAULT_MINUTES_PER_EDIT
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
  // DECISIONS 75 Р4: the tokens the agent metered in the range, by the event's own day and organization
  const tokens = db
    .select({ orgId: events.orgId, tsMs: events.tsMs, value: events.value, props: events.props })
    .from(events)
    .where(and(eq(events.appId, appId), eq(events.type, 'tokens.used'), gte(events.tsMs, fromMs), lt(events.tsMs, toMs)))
    .all()

  const rows = new Map<string, ReportRow>()
  const orgRows = new Map<string, ReportRow>()
  const users = new Map<string, Set<string>>()
  const orgUsers = new Map<string, Set<string>>()
  const row = (date: string, org: string) => {
    const k = `${date}\0${org}`
    let r = rows.get(k)
    if (!r) rows.set(k, (r = blank(date, org)))
    return r
  }
  const orgRow = (org: string) => {
    let r = orgRows.get(org)
    if (!r) orgRows.set(org, (r = blank('all', org)))
    return r
  }
  const inc = (r: ReportRow, c: ReportColumn, by = 1) => (r[c] = (r[c] as number) + by)
  const total = blank('total', 'all')
  const allUsers = new Set<string>()
  const allOrgs = new Set<string>()
  for (const q of reqs) {
    const date = dayOf(q.createdAtMs)
    for (const target of [row(date, q.orgId), orgRow(q.orgId), total]) {
      inc(target, 'requests')
      inc(target, VERDICT_COLUMN[q.verdict] ?? 'failed')
      if (q.snapshotId) inc(target, 'applied')
      for (const o of outcome.get(q.id) ?? []) inc(target, o as ReportColumn)
      inc(target, 'cost_usd', costOf(q.usage))
    }
    const k = `${date}\0${q.orgId}`
    users.set(k, (users.get(k) ?? new Set()).add(q.userId))
    orgUsers.set(q.orgId, (orgUsers.get(q.orgId) ?? new Set()).add(q.userId))
    allUsers.add(`${q.orgId}\0${q.userId}`)
    allOrgs.add(q.orgId)
  }
  for (const s of carried) {
    for (const target of [row(s.createdAt.slice(0, 10), s.orgId), orgRow(s.orgId), total]) inc(target, 'carry_overs')
    allOrgs.add(s.orgId)
  }
  const unpricedModels = new Set<string>()
  for (const e of tokens) {
    const p = (e.props ?? {}) as Record<string, unknown>
    const model = typeof p.model === 'string' ? p.model : ''
    const usd = model ? costUsd(model, { inputTokens: num(p.input), outputTokens: num(p.output), cacheReadTokens: num(p.cacheRead), cacheWriteTokens: num(p.cacheWrite) }) : null
    if (usd === null) unpricedModels.add(model || '(no model)')
    for (const target of [row(dayOf(e.tsMs), e.orgId), orgRow(e.orgId), total]) {
      if (usd === null) inc(target, 'unpriced_tokens', num(e.value))
      else inc(target, 'token_cost_usd', usd)
    }
    allOrgs.add(e.orgId)
  }

  const finish = (r: ReportRow) => {
    const applied = r.applied as number
    const tokenCost = r.token_cost_usd as number
    r.cost_usd = Number((r.cost_usd as number).toFixed(4))
    r.token_cost_usd = Number(tokenCost.toFixed(4))
    r.dev_hours_saved = Math.round((applied * minutesPerEdit) / 6) / 10
    r.cost_per_applied_edit_usd = applied > 0 ? Number((tokenCost / applied).toFixed(4)) : null
  }
  const byDateOrg = (a: ReportRow, b: ReportRow) => String(a.date).localeCompare(String(b.date)) || String(a.org).localeCompare(String(b.org))
  const out = [...rows.values()].sort(byDateOrg)
  for (const r of out) {
    r.orgs = 1
    r.users = users.get(`${r.date}\0${r.org}`)?.size ?? 0
    finish(r)
  }
  const orgs = [...orgRows.values()].sort(byDateOrg)
  for (const r of orgs) {
    r.orgs = 1
    r.users = orgUsers.get(String(r.org))?.size ?? 0
    finish(r)
  }
  total.orgs = allOrgs.size
  total.users = allUsers.size
  finish(total)
  return { appId, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), minutesPerEdit, rows: out, orgs, total, unpricedModels: [...unpricedModels].sort() }
}

/** RFC 4180: quote a field that has a comma, a quote or a line break; a leading `=+-@` is defused for spreadsheets. */
export function csvField(v: string | number | null): string {
  if (v === null) return ''
  let s = String(v)
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** The day × organization rows, then one row per organization over the range (`date` = `all`), then the total. */
export function reportCsv(r: Report): string {
  const lines = [REPORT_COLUMNS.join(',')]
  for (const row of [...r.rows, ...r.orgs, r.total]) lines.push(REPORT_COLUMNS.map((c) => csvField(row[c])).join(','))
  return lines.join('\r\n') + '\r\n'
}
