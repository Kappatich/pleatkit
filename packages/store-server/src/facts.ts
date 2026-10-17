import { createHmac, randomBytes } from 'node:crypto'
import { and, eq, lt, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'
import { agentRuns, appSalts, appSettings, requestFacts, requests } from './schema.js'

type Db = BetterSQLite3Database<typeof schema>

/**
 * The data flywheel's L1 layer (DECISIONS 44, brainstorm 12 A1): per request, a fingerprint without free text,
 * code, names or DOM. Users and panels are keyed with HMAC(tenant salt, id), the salt is per app and never leaves
 * store-server. Written only when the app's `learning` flag is not `off` (self-host default `off`; the cloud runs
 * `aggregate`; `contribute` only by an explicit pilot contract).
 */
export type Learning = 'off' | 'aggregate' | 'contribute'
export const LEARNING_MODES: Learning[] = ['off', 'aggregate', 'contribute']

/** Closed list of request labels (brainstorm 12 A2): the classifier picks one; L1 and L2 use it instead of text. */
export const INTENT_LABELS = [
  'fields-add', 'fields-remove', 'fields-reorder', 'conditional-style', 'color-theme', 'typography', 'layout-columns', 'layout-spacing',
  'layout-responsive', 'format-date', 'format-number', 'format-currency', 'sort', 'filter', 'search', 'group', 'aggregate-display', 'chart',
  'toggle-collapse', 'inline-edit', 'bulk-action', 'i18n-labels', 'a11y', 'empty-state', 'loading-state', 'icons', 'badges', 'tooltip',
  'navigation-link', 'hide-element', 'show-existing-data', 'out-of-zone', 'backend-field', 'backend-calculation', 'backend-integration',
  'permissions', 'off-topic', 'adversarial', 'undo-earlier-edit', 'migration', 'other',
] as const
export type IntentLabel = (typeof INTENT_LABELS)[number]

export function saltOf(db: Db, appId: string): string {
  const row = db.select().from(appSalts).where(eq(appSalts.appId, appId)).get()
  if (row) return row.salt
  const salt = randomBytes(32).toString('base64url')
  db.insert(appSalts).values({ appId, salt, createdAt: new Date().toISOString() }).onConflictDoNothing().run()
  return db.select().from(appSalts).where(eq(appSalts.appId, appId)).get()!.salt
}

export const hmacKey = (salt: string, value: string): string => createHmac('sha256', salt).update(value).digest('base64url').slice(0, 22)

export function learningOf(db: Db, appId: string, fallback: Learning): Learning {
  const v = db.select().from(appSettings).where(eq(appSettings.appId, appId)).get()?.learning
  return (LEARNING_MODES as string[]).includes(v ?? '') ? (v as Learning) : fallback
}

interface RunFacts {
  requestId: string
  appId: string
  orgId: string
  userId: string
  target: string | null
  verdict: string
  intentLabel: string | null
  usage: { model: string; calls: number; costUsd: number | null }[] | null
  log: { tool: string; ok: boolean; violation?: string }[]
  timings: { totalMs?: number } | null
  promptVersion: string | null
  model: string | null
  provider: string | null
  compilerVersion: string | null
}

/** Write the L1 row of one request (no text, no code, no names: labels, counts, keyed ids). */
export function recordFacts(db: Db, f: RunFacts, learning: Learning): boolean {
  if (learning === 'off') return false
  const salt = saltOf(db, f.appId)
  const toolCalls = f.log.length
  const writes = f.log.filter((l) => l.tool === 'write_file' || l.tool === 'edit_file').length
  const failedChecks = f.log.filter((l) => (l.tool === 'check' || l.tool === 'finish') && !l.ok).length
  const ruleHits = [...new Set(f.log.flatMap((l) => (l.violation ? [l.violation.replace(/^static check: /, '')] : [])))]
  const cost = (f.usage ?? []).reduce((s, u) => s + (u.costUsd ?? 0), 0)
  const turns = (f.usage ?? []).filter((u) => u.model === f.model).reduce((s, u) => s + u.calls, 0)
  db.insert(requestFacts)
    .values({
      requestId: f.requestId,
      appId: f.appId,
      orgId: f.orgId,
      userKey: hmacKey(salt, `user:${f.userId}`),
      panelKey: f.target ? hmacKey(salt, `panel:${f.target}`) : null,
      intentLabel: (INTENT_LABELS as readonly string[]).includes(f.intentLabel ?? '') ? f.intentLabel : f.intentLabel ? 'other' : null,
      verdict: f.verdict,
      firstTry: writes > 0 ? failedChecks === 0 : null,
      turns,
      toolCalls,
      costUsd: cost,
      latencyMs: typeof f.timings?.totalMs === 'number' ? f.timings.totalMs : null,
      promptVersion: f.promptVersion,
      model: f.model,
      provider: f.provider,
      compilerVersion: f.compilerVersion,
      staticRuleHits: ruleHits,
      outcome: null,
      learning,
      createdAtMs: Date.now(),
    })
    .onConflictDoNothing()
    .run()
  return true
}

/** Outcome labels only the runtime owner has (brainstorm 12 A5): alive24h, reverted:user, reverted:admin, ... */
export function setOutcome(db: Db, requestId: string, outcome: string): void {
  db.update(requestFacts).set({ outcome }).where(eq(requestFacts.requestId, requestId)).run()
}

export interface RetentionPolicy {
  /** Request text and target kept this many days (L0). Default 90. */
  textDays: number
  /** Tool logs (L0). Default 30. */
  logDays: number
  /** L1 facts. Default 548 (18 months). */
  factsDays: number
}
export const DEFAULT_RETENTION: RetentionPolicy = { textDays: 90, logDays: 30, factsDays: 548 }

/**
 * The retention job (DECISIONS 44): blank request text, targets and gists after `textDays`, tool logs and the
 * proposed files after `logDays`, delete L1 facts after `factsDays`, and finished run records after a day.
 * Snapshots live as long as the user's history (their deletion is the export/delete path). Idempotent.
 */
export function applyRetention(db: Db, now = Date.now(), policy: RetentionPolicy = DEFAULT_RETENTION): { text: number; logs: number; facts: number; runs: number } {
  const day = 86_400_000
  const text = db
    .update(requests)
    .set({ text: '', target: null, gist: null, retainedAt: new Date(now).toISOString() })
    .where(and(lt(requests.createdAtMs, now - policy.textDays * day), sql`${requests.text} <> ''`))
    .run().changes
  const logs = db
    .update(requests)
    .set({ log: [], files: null })
    .where(and(lt(requests.createdAtMs, now - policy.logDays * day), sql`${requests.log} <> '[]'`))
    .run().changes
  const facts = db.delete(requestFacts).where(lt(requestFacts.createdAtMs, now - policy.factsDays * day)).run().changes
  const runs = db.delete(agentRuns).where(lt(agentRuns.createdAtMs, now - day)).run().changes
  return { text, logs, facts, runs }
}
