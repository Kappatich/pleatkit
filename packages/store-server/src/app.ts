import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { applyQuotaOps, signingKeyFromAppKey, sriDigest, verifyBundleSignature, type BundleSignature, type QuotaOp } from '@pleatkit/runtime/compiler'
import { AuthError, resolveCaller, type AuthOptions, type Caller } from './auth.js'
import { buildExport } from './export.js'
import { deleteFlag, FLAG_SCOPES, listFlags, resolveFlags, setFlag, type FlagScope } from './flags.js'
import { idempotencyMiddleware } from './idempotency.js'
import { eraseSubject, tombstoneId } from './erase.js'
import { attachExtensions, type ExtensionContext, type StoreDb, type StoreEnv, type StoreExtension } from './extension.js'
import { appendAudit, EVENT_TYPES, markEditorActive, recordEvent, verifyAuditChain, type EventType } from './ledger.js'
import { buildReport, DEFAULT_MINUTES_PER_EDIT, MAX_MINUTES_PER_EDIT, parseMinutesPerEdit, parseRange, reportCsv } from './report.js'
import { grepError, grepSnapshots, planSelectionRollback } from './selection.js'
import * as schema from './schema.js'
import { agentRuns, appPlans, appSettings, audit, bundleFiles, events, heads, quotaBuckets, releaseItems, releases, requests, snapshots, wishMaps, type WishCluster } from './schema.js'

export type { StoreDb } from './extension.js'

/**
 * Moderation of agent edits (DECISIONS item 15). `off`: an applied edit is just applied. `review`: it is
 * applied for the user at once, but marked `pending-review`; the admin sees it at the top of the list and
 * approves it or rolls it back with one click. (Holding edits until approval is deliberately not built.)
 */
export type Moderation = 'off' | 'review'

export interface StoreAppOptions {
  /** Default for apps whose admin has not chosen (`PLEATKIT_MODERATION`). Default `off`. */
  moderation?: Moderation
  /**
   * Who may call (V1 A1). Default: demo headers only (development and tests). The CLI builds it with
   * `authFromEnv`, which refuses to start in production without an app key and a user-JWT secret.
   */
  auth?: AuthOptions
  /** F2: where this store runs (`PLEATKIT_REGION`), recorded on every row. Default `local`. */
  region?: string
  /** F2: environment recorded when the caller does not say (`PLEATKIT_ENVIRONMENT`). Default `development`. */
  environment?: string
  /** Largest request body, bytes (`PLEATKIT_STORE_BODY_LIMIT`). Default 4 MiB. */
  bodyLimitBytes?: number
  /**
   * DECISIONS 75 Р4: minutes one applied edit saves a developer, for the report's `dev_hours_saved`
   * (`PLEATKIT_REPORT_MINUTES_PER_EDIT`). Default 20; the report's `minutesPerEdit` query parameter wins.
   */
  reportMinutesPerEdit?: number
  /**
   * DECISIONS 70.1: modules on top of the open core (the managed cloud's `@pleatkit/store-cloud`): their tables,
   * routes, jobs and hooks. None by default.
   */
  extensions?: readonly StoreExtension[]
}

/** DECISIONS 70.3: wish items per read (the map's default input) and the most one read returns. */
export const WISH_ITEMS_DEFAULT = 500
export const WISH_ITEMS_MAX = 2000

/** A snapshot of a big zone is a few hundred KB; a request log with tool results stays well under this. */
export const DEFAULT_BODY_LIMIT = 4 * 1024 * 1024

export interface StoreOptions {
  /** SQLite file, or `:memory:` (default). */
  file?: string
}

export function openStore(options: StoreOptions = {}): { db: StoreDb; close: () => void } {
  const file = options.file ?? ':memory:'
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  const sqlite = new Database(file)
  sqlite.pragma('journal_mode = WAL')
  sqlite.exec(schema.DDL)
  for (const { table, column, type } of schema.ADDED_COLUMNS) {
    const has = (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)
    if (!has) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
  // Stage 4b: snapshots keyed by (app_id, id) and insert-only
  const pk = (sqlite.prepare('PRAGMA table_info(snapshots)').all() as { name: string; pk: number }[]).filter((c) => c.pk > 0).map((c) => c.name)
  if (!pk.includes('app_id')) sqlite.transaction(() => sqlite.exec(schema.SNAPSHOT_PK_MIGRATION))()
  sqlite.exec(schema.SNAPSHOT_TRIGGERS)
  sqlite.exec(schema.ERASURE_TRIGGERS)
  return { db: drizzle(sqlite, { schema }), close: () => sqlite.close() }
}

type SnapshotRow = typeof snapshots.$inferSelect
type RequestRow = typeof requests.$inferSelect

/** Wire shape of a snapshot (= `Snapshot` in @pleatkit/runtime). */
function toSnapshot(r: SnapshotRow) {
  return {
    id: r.id,
    parentId: r.parentId,
    userId: r.userId,
    files: r.files,
    message: r.message,
    author: r.author,
    createdAt: r.createdAt,
    status: r.status,
    ...(r.baseHash ? { baseHash: r.baseHash } : {}),
    ...(r.requestId ? { requestId: r.requestId } : {}),
    ...(r.baseFiles ? { baseFiles: r.baseFiles } : {}),
    // missing means 1 (F4), so older clients see the shape they wrote
    ...(r.schemaVersion > 1 ? { schemaVersion: r.schemaVersion } : {}),
  }
}

const STATUSES = ['proposed', 'applied', 'pending-review', 'clarifying', 'rejected', 'pending-admin', 'in-progress', 'rolled-back', 'failed', 'refused'] as const
const now = () => new Date().toISOString()

type Env = StoreEnv
const caller = (c: Context<Env>): Caller => c.get('caller')

/** Bundle key of a server-compiled bundle: lowercase hex, the only thing allowed in a public bundle URL. */
const KEY_RE = /^[0-9a-f]{16,64}$/

export function createStoreApp(db: StoreDb, options: StoreAppOptions = {}) {
  const auth: AuthOptions = options.auth ?? { demoHeaders: true }
  if (auth.production && auth.demoHeaders) throw new Error('demo headers are not allowed in production')
  const extensions = options.extensions ?? []
  attachExtensions(db, extensions)
  const app = new Hono<Env>()
  const region = options.region ?? 'local'
  const defaultEnvironment = options.environment ?? 'development'
  const place = (who: Caller) => ({ region, environment: who.environment ?? defaultEnvironment })
  /** Actor of an audit row: who did it, as the server authenticated them; an impersonation names both (C8). */
  const actor = (who: Caller) =>
    who.agent
      ? `agent${who.userId ? `:for:${who.userId}` : ''}`
      : who.viewer
        ? `${who.role}:${who.viewer}:as:${who.userId}`
        : who.admin && !who.userId
          ? 'admin'
          : `${who.role}:${who.userId}`
  const audited = (who: Caller, action: string, objectType: string, objectId: string | null, details: Record<string, unknown> | null = null) =>
    appendAudit(db, { appId: who.appId, orgId: who.orgId, actor: actor(who), action, objectType, objectId, details })
  const event = (who: Caller, type: EventType, userId: string | null, requestId: string | null, extra: { value?: number; unit?: string; props?: Record<string, unknown>; dedupeKey?: string } = {}) =>
    recordEvent(db, {
      type,
      value: extra.value ?? 1,
      unit: extra.unit ?? 'edit',
      appId: who.appId,
      orgId: who.orgId,
      userId,
      requestId,
      source: 'store',
      dedupeKey: extra.dedupeKey ?? null,
      props: extra.props ?? null,
      ...place(who),
    })
  /** An outcome of an agent edit, for the extensions (the cloud's L1 facts). */
  const outcome = (requestId: string, label: string) => extensions.forEach((e) => e.onOutcome?.(db, requestId, label))
  const defaultModeration: Moderation = options.moderation ?? 'off'
  const moderationOf = (appId: string): Moderation =>
    (db.select().from(appSettings).where(eq(appSettings.appId, appId)).get()?.moderation as Moderation | undefined) ?? defaultModeration

  const canSee = (who: Caller, userId: string) => who.admin || who.userId === userId
  const getSnapshot = (appId: string, id: string) => db.select().from(snapshots).where(and(eq(snapshots.appId, appId), eq(snapshots.id, id))).get()
  const getHead = (appId: string, userId: string) => db.select().from(heads).where(and(eq(heads.appId, appId), eq(heads.userId, userId))).get()
  const setHead = (appId: string, userId: string, snapshotId: string, orgId = 'default') =>
    db
      .insert(heads)
      .values({ appId, userId, snapshotId, updatedAt: now(), orgId })
      .onConflictDoUpdate({ target: [heads.appId, heads.userId], set: { snapshotId, updatedAt: now() } })
      .run()
  const getRequest = (appId: string, id: string) => db.select().from(requests).where(and(eq(requests.appId, appId), eq(requests.id, id))).get()
  const patchRequest = (id: string, patch: Partial<RequestRow>) =>
    db
      .update(requests)
      .set({ ...patch, updatedAt: now() })
      .where(eq(requests.id, id))
      .run()

  app.get('/health', (c) => c.json({ ok: true }))

  // Public, unauthenticated: signed bundles by their unguessable content key, so `<script type="module">` and
  // `import()` can load them from the app's origin (V1 B1). Only bundles the agent server compiled and signed.
  app.get('/v1/b/:app/:file', (c) => {
    const m = /^([0-9a-f]{16,64})\.(js|css|json)$/.exec(c.req.param('file'))
    if (!m) return c.json({ error: 'not found' }, 404)
    const row = db
      .select()
      .from(bundleFiles)
      .where(and(eq(bundleFiles.appId, c.req.param('app')), eq(bundleFiles.key, m[1]!), eq(bundleFiles.owner, '')))
      .get()
    if (!row) return c.json({ error: 'not found' }, 404)
    // CORS: isolated panels load bundles from an opaque-origin iframe; the content is public and immutable anyway
    const headers = { 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*' }
    if (m[2] === 'js') return c.body(row.js, 200, { ...headers, 'content-type': 'text/javascript; charset=utf-8' })
    if (m[2] === 'css') return c.body(row.css, 200, { ...headers, 'content-type': 'text/css; charset=utf-8' })
    return c.json(row.signature ?? {}, 200, headers)
  })

  // Everything else needs a caller: app key, user token, or (development only) demo headers.
  const api = new Hono<Env>()
  api.use('*', async (c, next) => {
    try {
      c.set('caller', await resolveCaller((name) => c.req.header(name), auth))
    } catch (e) {
      if (e instanceof AuthError) return c.json({ error: e.message }, e.status)
      throw e
    }
    await next()
  })
  // C8: every call made while acting as a user goes to the audit chain with both ids, reads included.
  // DECISIONS 70.5: support reads as the user and never writes; only the admin role writes as a user. A refused
  // write is audited too, with its 403.
  api.use('*', async (c, next) => {
    const who = caller(c)
    if (!who.viewer) return next()
    const read = c.req.method === 'GET' || c.req.method === 'HEAD'
    const path = c.req.path.replace(/^\/v1(?=\/)/, '')
    const record = (status: number) =>
      audited(who, read ? 'impersonate.read' : 'impersonate.write', 'user', who.userId, { viewer: who.viewer, user: who.userId, role: who.role, method: c.req.method, path, status })
    if (!read && who.role !== 'admin') {
      record(403)
      return c.json({ error: 'support reads as a user and cannot write; only an admin may write as a user', code: 'support-read-only' }, 403)
    }
    await next()
    record(c.res.status)
  })
  // Bodies are read only after the caller is known, and never beyond the limit (code review 06 item 7): 413
  api.use('*', bodyLimit({ maxSize: options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT, onError: (c) => c.json({ error: 'request body is too large' }, 413) }))
  // F5: writes with an Idempotency-Key run once; retries get the stored response
  api.use('*', idempotencyMiddleware(db))

  /** Public per-app settings (the chat tells the user when edits are reviewed). */
  api.get('/settings', (c) => c.json({ moderation: moderationOf(caller(c).appId) }))

  /** F6: flags for the caller (defaults < app < org < user); the runtime and the agent server read them. */
  api.get('/flags', (c) => {
    const who = caller(c)
    const userId = c.req.query('userId') ?? who.userId
    if (userId && !canSee({ ...who, admin: who.admin || who.agent }, userId)) return c.json({ error: 'forbidden' }, 403)
    return c.json({ flags: resolveFlags(db, who.appId, c.req.query('orgId') && (who.agent || who.admin) ? c.req.query('orgId')! : who.orgId, userId) })
  })

  /** F3: usage events from the agent server (`edit.requested`, `tokens.used`, `cost.usd`). Append-only. */
  api.post('/events', async (c) => {
    const who = caller(c)
    if (!who.agent) return c.json({ error: 'agent only' }, 403)
    const b = await c.req.json<{ events?: unknown[] }>().catch(() => ({}) as { events?: unknown[] })
    if (!Array.isArray(b.events) || b.events.length === 0 || b.events.length > 100) return c.json({ error: 'events: 1 to 100 events' }, 400)
    let stored = 0
    for (const raw of b.events as Record<string, unknown>[]) {
      const type = raw?.type as EventType
      if (!EVENT_TYPES.includes(type) || typeof raw.value !== 'number' || !Number.isFinite(raw.value) || typeof raw.unit !== 'string') {
        return c.json({ error: `bad event: ${JSON.stringify(raw).slice(0, 200)}` }, 400)
      }
      const ok = recordEvent(db, {
        type,
        value: raw.value,
        unit: raw.unit,
        appId: who.appId,
        orgId: who.orgId,
        userId: typeof raw.userId === 'string' ? raw.userId : who.userId,
        requestId: typeof raw.requestId === 'string' ? raw.requestId : null,
        source: 'agent',
        dedupeKey: typeof raw.dedupeKey === 'string' ? raw.dedupeKey.slice(0, 200) : null,
        props: raw.props && typeof raw.props === 'object' ? (raw.props as Record<string, unknown>) : null,
        ...place(who),
      })
      if (ok) stored++
    }
    return c.json({ stored }, 201)
  })

  // --- snapshots & heads (used by HttpStore in the browser) ---

  api.get('/heads/:userId', (c) => {
    const who = caller(c)
    const userId = c.req.param('userId')
    if (!canSee(who, userId)) return c.json({ error: 'forbidden' }, 403)
    const head = getHead(who.appId, userId)
    const snap = head ? getSnapshot(who.appId, head.snapshotId) : undefined
    return c.json({ snapshot: snap ? toSnapshot(snap) : null })
  })

  api.get('/snapshots', (c) => {
    const who = caller(c)
    const userId = c.req.query('userId') ?? who.userId
    if (!userId || !canSee(who, userId)) return c.json({ error: 'forbidden' }, 403)
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 500)
    const rows = db
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.appId, who.appId), eq(snapshots.userId, userId)))
      .orderBy(desc(snapshots.id))
      .limit(limit)
      .all()
    return c.json(rows.map(toSnapshot))
  })

  api.get('/snapshots/:id', (c) => {
    const who = caller(c)
    const snap = getSnapshot(who.appId, c.req.param('id'))
    if (!snap) return c.json({ error: 'not found' }, 404)
    if (!canSee(who, snap.userId)) return c.json({ error: 'forbidden' }, 403)
    return c.json(toSnapshot(snap))
  })

  /**
   * Store a snapshot. Insert-only (code review 06 item 7): the same id again with the same content is a no-op
   * (a retry), with other content 409. The server decides what the client must not: when it was made, its
   * status (`applied` or `rejected`, nothing else) and its author (`base` only without a parent, `admin` only
   * for an admin acting on another user, otherwise `agent` or `user` as the client says).
   */
  api.put('/snapshots/:id', async (c) => {
    const who = caller(c)
    const body = await c.req.json<ReturnType<typeof toSnapshot>>().catch(() => null)
    if (!body || typeof body !== 'object') return c.json({ error: 'body must be a JSON snapshot' }, 400)
    if (body.id !== c.req.param('id') || typeof body.id !== 'string' || body.id.length > 64) return c.json({ error: 'id mismatch' }, 400)
    if (typeof body.userId !== 'string' || !canSee(who, body.userId)) return c.json({ error: 'forbidden' }, 403)
    const files = body.files as Record<string, unknown> | undefined
    if (!files || typeof files !== 'object' || Object.values(files).some((s) => typeof s !== 'string')) return c.json({ error: 'files must map paths to strings' }, 400)
    const parentId = typeof body.parentId === 'string' ? body.parentId : null
    if (parentId) {
      const parent = getSnapshot(who.appId, parentId)
      if (!parent || parent.userId !== body.userId) return c.json({ error: 'parent not found for this user' }, 400)
    }
    const status = body.status === 'rejected' ? 'rejected' : 'applied'
    const author = !parentId ? 'base' : who.admin && who.userId !== body.userId ? 'admin' : body.author === 'agent' ? 'agent' : 'user'
    const existing = getSnapshot(who.appId, body.id)
    if (existing) {
      const same = existing.userId === body.userId && existing.parentId === parentId && existing.status === status && JSON.stringify(existing.files) === JSON.stringify(files)
      return same ? c.body(null, 204) : c.json({ error: 'snapshots are insert-only: this id exists with other content', code: 'immutable' }, 409)
    }
    const row = {
      id: body.id,
      appId: who.appId,
      userId: body.userId,
      parentId,
      files: files as Record<string, string>,
      message: String(body.message ?? '').slice(0, 2000),
      author,
      createdAt: now(),
      status,
      baseHash: typeof body.baseHash === 'string' ? body.baseHash : null,
      requestId: null as string | null,
      orgId: who.orgId,
      ...place(who),
      baseFiles: body.baseFiles && typeof body.baseFiles === 'object' ? body.baseFiles : null,
      schemaVersion: typeof body.schemaVersion === 'number' ? body.schemaVersion : 1,
    }
    // a request id is kept only when it is a request of this user in this app
    if (typeof body.requestId === 'string') {
      const req = getRequest(who.appId, body.requestId)
      if (req && req.userId === body.userId) row.requestId = req.id
    }
    db.insert(snapshots).values(row).run()
    audited(who, 'snapshot.create', 'snapshot', body.id, { userId: body.userId, parentId: row.parentId, status: row.status, author: row.author, files: Object.keys(row.files).length })
    return c.body(null, 204)
  })

  /**
   * Move a user's head. With `{ expectedHeadId }` in the body (code review 06 item 6) it is a compare-and-set:
   * when the head is not that snapshot any more (another tab or device, an admin rollback), 409 with
   * `code: 'head-conflict'` and the actual head, and nothing changes.
   */
  api.post('/snapshots/:id/head', async (c) => {
    const who = caller(c)
    const snap = getSnapshot(who.appId, c.req.param('id'))
    if (!snap) return c.json({ error: 'not found' }, 404)
    if (!canSee(who, snap.userId)) return c.json({ error: 'forbidden' }, 403)
    if (snap.status === 'rejected') return c.json({ error: 'a rejected snapshot cannot become the head' }, 409)
    const b = await c.req.json<{ expectedHeadId?: string | null }>().catch(() => ({}) as { expectedHeadId?: string | null })
    const cas = b && typeof b === 'object' && 'expectedHeadId' in b
    const swapped = db.transaction(() => {
      const before = getHead(who.appId, snap.userId)
      if (cas && (before?.snapshotId ?? null) !== (b.expectedHeadId ?? null)) return { conflict: true as const, actual: before?.snapshotId ?? null }
      setHead(who.appId, snap.userId, snap.id, who.orgId)
      return { conflict: false as const, before }
    })
    if (swapped.conflict) return c.json({ error: 'the head moved since this client read it', code: 'head-conflict', expected: b.expectedHeadId ?? null, actual: swapped.actual }, 409)
    const before = swapped.before
    const old = before ? getSnapshot(who.appId, before.snapshotId) : undefined
    audited(who, 'head.set', 'head', snap.userId, { from: before?.snapshotId ?? null, to: snap.id })
    // the user undid an agent edit: its snapshot left the head for its parent (F3)
    if (old?.requestId && old.parentId === snap.id) {
      event(who, 'edit.reverted', snap.userId, old.requestId, { props: { by: 'user' } })
      outcome(old.requestId, 'reverted:user')
    }
    return c.body(null, 204)
  })

  // --- bundle cache ---

  /** A cached bundle the caller may use: one the agent server made (signed) or one this user's browser made. */
  api.get('/bundles/:key', (c) => {
    const who = caller(c)
    const key = c.req.param('key')
    const rows = db
      .select()
      .from(bundleFiles)
      .where(and(eq(bundleFiles.appId, who.appId), eq(bundleFiles.key, key)))
      .all()
    const row = rows.find((r) => r.owner === '') ?? rows.find((r) => who.userId !== null && r.owner === who.userId)
    if (!row) return c.json({ error: 'not found' }, 404)
    return c.json({ js: row.js, css: row.css, ...(row.signature ? { signature: row.signature } : {}) })
  })

  /**
   * Store a bundle. From the agent server (app key) it must carry a valid signature by the app's key and is
   * then public under /v1/b/; in development (demo headers) the agent may store it unsigned. From a user's
   * browser it is kept for that user only.
   */
  api.put('/bundles/:key', async (c) => {
    const who = caller(c)
    const key = c.req.param('key')
    if (key.length > 200) return c.json({ error: 'bad key' }, 400)
    const body = await c.req.json<{ js?: unknown; css?: unknown; signature?: BundleSignature }>().catch(() => ({}) as { js?: unknown })
    const { js, css } = body as { js?: unknown; css?: unknown }
    if (typeof js !== 'string' || typeof css !== 'string') return c.json({ error: 'js and css are required' }, 400)
    let owner: string
    let signature: BundleSignature | null = null
    if (who.agent) {
      if (!KEY_RE.test(key)) return c.json({ error: 'server bundles need a hex key' }, 400)
      signature = (body as { signature?: BundleSignature }).signature ?? null
      const p = signature?.payload
      if (!p || p.key !== key || p.app !== who.appId) return c.json({ error: 'signature payload does not match this bundle' }, 400)
      if (p.js !== (await sriDigest(js)) || p.css !== (await sriDigest(css))) return c.json({ error: 'signature digests do not match the files' }, 400)
      if (who.via === 'app-key') {
        const creds = auth.apps?.[who.appId]
        try {
          await verifyBundleSignature(signature!, (await signingKeyFromAppKey(creds!.appKey)).publicKey)
        } catch (e) {
          return c.json({ error: (e as Error).message }, 400)
        }
      }
      owner = ''
    } else if (who.userId) {
      owner = who.userId
    } else {
      return c.json({ error: 'forbidden' }, 403)
    }
    const stored = db
      .insert(bundleFiles)
      .values({ appId: who.appId, key, owner, js, css, signature: signature as unknown as Record<string, unknown> | null, createdAt: now(), orgId: who.orgId })
      .onConflictDoNothing()
      .run()
    if (stored.changes > 0 && who.agent) audited(who, 'bundle.store', 'bundle', key, { signed: Boolean(signature?.sig), keyId: signature?.keyId ?? null })
    return c.body(null, 204)
  })

  // --- quotas and plan (V1 A4, F14): the agent server keeps its policy, store-server keeps the buckets ---

  /** Apply token-bucket operations atomically. Agent server only. */
  api.post('/quota', async (c) => {
    const who = caller(c)
    if (!who.agent) return c.json({ error: 'agent only' }, 403)
    const { ops } = await c.req.json<{ ops?: QuotaOp[] }>().catch(() => ({}) as { ops?: QuotaOp[] })
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > 20) return c.json({ error: 'ops: 1 to 20 operations' }, 400)
    for (const op of ops) {
      if (typeof op?.key !== 'string' || !['take', 'debit', 'peek'].includes(op.op) || !(op.capacity >= 0) || !(op.refillPerSec >= 0)) {
        return c.json({ error: 'bad operation' }, 400)
      }
    }
    const outcome = db.transaction((tx) => {
      const read = (key: string) => {
        const r = tx
          .select()
          .from(quotaBuckets)
          .where(and(eq(quotaBuckets.appId, who.appId), eq(quotaBuckets.key, key)))
          .get()
        return r ? { tokens: r.tokens, updatedMs: r.updatedMs } : undefined
      }
      const { outcome, writes } = applyQuotaOps(read, ops, Date.now())
      for (const [key, st] of Object.entries(writes)) {
        tx.insert(quotaBuckets)
          .values({ appId: who.appId, key, tokens: st.tokens, updatedMs: st.updatedMs })
          .onConflictDoUpdate({ target: [quotaBuckets.appId, quotaBuckets.key], set: { tokens: st.tokens, updatedMs: st.updatedMs } })
          .run()
      }
      return outcome
    })
    return c.json(outcome)
  })

  const planOf = (appId: string) => {
    const row = db.select().from(appPlans).where(eq(appPlans.appId, appId)).get()
    return { plan: row?.plan ?? null, limits: row?.limits ?? {} }
  }

  /** The app's plan name and limit overrides (the agent merges them over its default plan). */
  api.get('/plan', (c) => {
    const who = caller(c)
    if (!who.agent && !who.admin) return c.json({ error: 'forbidden' }, 403)
    return c.json(planOf(who.appId))
  })

  /**
   * DECISIONS 75 Р5: the classifier's record of the app since `sinceMs` (at most 7 days back), in hourly buckets, so
   * the agent server can pick parallel or sequential per app. `classified`: requests where the classifier ran
   * (`timings.classifyMs` set); `alone`: of those, the ones it answered alone (a needs-backend, clarify, refused or
   * declined verdict with an empty tool log: the main model was not used). Mirrors `answeredByClassifierAlone` in
   * @pleatkit/agent. Agent server or admin.
   */
  api.get('/classifier-stats', (c) => {
    const who = caller(c)
    if (!who.agent && !who.admin) return c.json({ error: 'forbidden' }, 403)
    const week = 7 * 24 * 60 * 60 * 1000
    const asked = Number(c.req.query('sinceMs'))
    const sinceMs = Math.max(Date.now() - week, Number.isFinite(asked) ? asked : 0)
    const hour = 60 * 60 * 1000
    const buckets = db
      .select({
        // integer division in SQL (a bound number would be a REAL)
        hourMs: sql<number>`(${requests.createdAtMs} / ${sql.raw(String(hour))}) * ${sql.raw(String(hour))}`,
        classified: sql<number>`count(*)`,
        alone: sql<number>`sum(CASE WHEN ${requests.verdict} IN ('needs-backend', 'clarify', 'refused', 'declined') AND json_array_length(${requests.log}) = 0 THEN 1 ELSE 0 END)`,
      })
      .from(requests)
      .where(and(eq(requests.appId, who.appId), gte(requests.createdAtMs, sinceMs), sql`json_extract(${requests.timings}, '$.classifyMs') IS NOT NULL`))
      .groupBy(sql`1`)
      .orderBy(sql`1`)
      .all()
    return c.json({ sinceMs, bucketMs: hour, buckets: buckets.map((b) => ({ hourMs: Number(b.hourMs), classified: Number(b.classified), alone: Number(b.alone ?? 0) })) })
  })

  // --- request log ---

  api.post('/requests', async (c) => {
    const who = caller(c)
    const b = await c.req.json<Partial<RequestRow> & { userId: string; text: string }>()
    if (!b.userId || !canSee({ ...who, admin: who.admin || who.agent }, b.userId)) return c.json({ error: 'forbidden' }, 403)
    const status = STATUSES.includes(b.status as (typeof STATUSES)[number]) ? b.status! : 'proposed'
    const id = `req_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    const t = now()
    db.insert(requests)
      .values({
        id,
        appId: who.appId,
        userId: b.userId,
        text: String(b.text ?? ''),
        target: b.target ?? null,
        verdict: b.verdict ?? 'failed',
        summary: b.summary ?? '',
        status,
        classification: b.classification ?? null,
        provider: b.provider ?? null,
        model: b.model ?? null,
        usage: b.usage ?? null,
        timings: b.timings ?? null,
        log: b.log ?? [],
        files: b.files ?? null,
        snapshotId: null,
        error: typeof b.error === 'string' ? b.error.slice(0, 2000) : null,
        attachments: b.attachments && typeof b.attachments === 'object' ? b.attachments : null,
        // what the server side of a partial or needs-backend request would need (the agent's backend_note)
        adminNote: typeof (b as unknown as { backendNote?: unknown }).backendNote === "string" ? String((b as unknown as { backendNote: string }).backendNote).slice(0, 1000) : null,
        createdAt: t,
        updatedAt: t,
        createdAtMs: Date.now(),
        orgId: who.orgId,
        ...place(who),
        promptVersion: typeof b.promptVersion === 'string' ? b.promptVersion : null,
        intentLabel: typeof b.intentLabel === 'string' ? b.intentLabel.slice(0, 40) : null,
        gist: typeof b.gist === 'string' ? b.gist.slice(0, 120) : null,
      })
      .run()
    // extensions see the run (the cloud writes its L1 fingerprint when the app's learning flag allows it)
    if (extensions.length) {
      const logged = {
        id,
        appId: who.appId,
        orgId: who.orgId,
        userId: b.userId,
        target: b.target ?? null,
        verdict: b.verdict ?? 'failed',
        intentLabel: typeof b.intentLabel === 'string' ? b.intentLabel : null,
        usage: Array.isArray(b.usage) ? b.usage : null,
        log: Array.isArray(b.log) ? b.log : [],
        timings: b.timings && typeof b.timings === 'object' ? b.timings : null,
        promptVersion: typeof b.promptVersion === 'string' ? b.promptVersion : null,
        model: b.model ?? null,
        provider: b.provider ?? null,
        compilerVersion: typeof (b as unknown as { compilerVersion?: unknown }).compilerVersion === 'string' ? (b as unknown as { compilerVersion: string }).compilerVersion : null,
      }
      for (const e of extensions) e.onRequestLogged?.(db, logged)
    }
    audited(who, 'request.create', 'request', id, { userId: b.userId, verdict: b.verdict ?? 'failed', status })
    markEditorActive(db, { appId: who.appId, orgId: who.orgId, userId: b.userId, requestId: id, ...place(who) })
    return c.json({ id }, 201)
  })

  /** The user's browser reports what happened to the agent's result (committed as a snapshot, or not). */
  api.post('/requests/:id/link', async (c) => {
    const who = caller(c)
    const req = getRequest(who.appId, c.req.param('id'))
    if (!req) return c.json({ error: 'not found' }, 404)
    if (!canSee(who, req.userId)) return c.json({ error: 'forbidden' }, 403)
    const b = await c.req.json<{ snapshotId?: string; status: string; error?: string }>()
    if (!STATUSES.includes(b.status as (typeof STATUSES)[number])) return c.json({ error: 'bad status' }, 400)
    if (b.snapshotId) {
      const snap = getSnapshot(who.appId, b.snapshotId)
      if (!snap || snap.userId !== req.userId) return c.json({ error: 'snapshot not found for this user' }, 400)
      // the one metadata column of an insert-only snapshot: the request it came from, linked once
      if (!snap.requestId) db.update(snapshots).set({ requestId: req.id }).where(and(eq(snapshots.appId, who.appId), eq(snapshots.id, snap.id))).run()
    }
    // under moderation an applied edit stays applied for the user, but waits for the admin's review
    const status = b.status === 'applied' && moderationOf(who.appId) === 'review' ? 'pending-review' : b.status
    patchRequest(req.id, { status, snapshotId: b.snapshotId ?? req.snapshotId, error: b.error ?? null })
    audited(who, 'request.link', 'request', req.id, { status, snapshotId: b.snapshotId ?? null })
    if (status === 'applied' || status === 'pending-review') event(who, 'edit.applied', req.userId, req.id, { dedupeKey: `edit.applied:${req.id}` })
    return c.json({ status })
  })

  // --- admin ---

  /**
   * C8: `admin` may do everything under /admin; `support` may read it (except the bulk export) and change nothing,
   * other than through impersonation, where it acts as the user and every call is audited.
   */
  const adminOnly = async (c: Context, next: () => Promise<void>) => {
    const who = caller(c)
    const read = c.req.method === 'GET' && !c.req.path.endsWith('/admin/export')
    if (!who.admin && !(read && who.role === 'support')) return c.json({ error: read ? 'admin or support only' : 'admin only' }, 403)
    await next()
  }
  api.use('/admin/*', adminOnly)

  api.get('/admin/requests', (c) => {
    const who = caller(c)
    const status = c.req.query('status')
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 1000)
    // edits awaiting review and backend requests first, newest first within each group: ordered in SQL before
    // the limit, and whether each is live comes from one join (code review 06 item 7, no N+1)
    const rows = db
      .select({ r: requests, headSnapshot: heads.snapshotId })
      .from(requests)
      .leftJoin(heads, and(eq(heads.appId, requests.appId), eq(heads.userId, requests.userId)))
      .where(status ? and(eq(requests.appId, who.appId), eq(requests.status, status)) : eq(requests.appId, who.appId))
      .orderBy(sql`CASE ${requests.status} WHEN 'pending-review' THEN 2 WHEN 'pending-admin' THEN 1 ELSE 0 END DESC`, desc(requests.createdAtMs))
      .limit(limit)
      .all()
    // the list stays light: no files, log only as a count
    return c.json(rows.map(({ r: { files: _files, log, ...r }, headSnapshot }) => ({ ...r, toolCalls: log.length, isHead: Boolean(r.snapshotId) && headSnapshot === r.snapshotId })))
  })

  api.get('/admin/settings', (c) => {
    const appId = caller(c).appId
    return c.json(Object.assign({ moderation: moderationOf(appId), default: defaultModeration }, ...extensions.map((e) => e.settings?.(db, appId) ?? {})))
  })

  // --- DECISIONS 42: agent runs by Idempotency-Key, shared by all agent instances ---

  /** Claim a run key: `claimed` (go ahead), `running` (another instance has it), `done` (with its result). */
  api.post('/runs/claim', async (c) => {
    const who = caller(c)
    if (!who.agent) return c.json({ error: 'agent only' }, 403)
    const b = await c.req.json<{ userId?: string; key?: string }>().catch(() => ({}) as { userId?: string; key?: string })
    if (typeof b.userId !== 'string' || typeof b.key !== 'string' || !b.key || b.key.length > 200) return c.json({ error: 'userId and key are required' }, 400)
    const out = db.transaction((tx) => {
      const row = tx.select().from(agentRuns).where(and(eq(agentRuns.appId, who.appId), eq(agentRuns.userId, b.userId!), eq(agentRuns.key, b.key!))).get()
      if (row) return row.state === 'done' ? { state: 'done', result: row.result } : { state: 'running' }
      tx.insert(agentRuns).values({ appId: who.appId, userId: b.userId!, key: b.key!, state: 'running', result: null, createdAtMs: Date.now() }).run()
      return { state: 'claimed' }
    })
    return c.json(out)
  })

  /** Store a run's result (`result: null` releases a failed claim so a retry runs again). */
  api.put('/runs/:key', async (c) => {
    const who = caller(c)
    if (!who.agent) return c.json({ error: 'agent only' }, 403)
    const b = await c.req.json<{ userId?: string; result?: Record<string, unknown> | null }>().catch(() => ({}) as { userId?: string; result?: null })
    if (typeof b.userId !== 'string') return c.json({ error: 'userId is required' }, 400)
    const where = and(eq(agentRuns.appId, who.appId), eq(agentRuns.userId, b.userId), eq(agentRuns.key, c.req.param('key')))
    if (!b.result) db.delete(agentRuns).where(where).run()
    else db.update(agentRuns).set({ state: 'done', result: b.result }).where(where).run()
    return c.body(null, 204)
  })

  api.put('/admin/settings', async (c) => {
    const who = caller(c)
    const b = await c.req.json<{ moderation?: string }>().catch(() => ({}) as { moderation?: string })
    if (b.moderation !== 'off' && b.moderation !== 'review') return c.json({ error: 'moderation must be "off" or "review"' }, 400)
    db.insert(appSettings)
      .values({ appId: who.appId, moderation: b.moderation, updatedAt: now() })
      .onConflictDoUpdate({ target: appSettings.appId, set: { moderation: b.moderation, updatedAt: now() } })
      .run()
    audited(who, 'settings.update', 'app', who.appId, { moderation: b.moderation })
    return c.json({ moderation: b.moderation })
  })

  const isHead = (appId: string, userId: string, snapshotId: string | null) => Boolean(snapshotId) && getHead(appId, userId)?.snapshotId === snapshotId

  api.get('/admin/requests/:id', (c) => {
    const who = caller(c)
    const req = getRequest(who.appId, c.req.param('id'))
    if (!req) return c.json({ error: 'not found' }, 404)
    const snap = req.snapshotId ? getSnapshot(who.appId, req.snapshotId) : undefined
    const parent = snap?.parentId ? getSnapshot(who.appId, snap.parentId) : undefined
    return c.json({
      request: { ...req, isHead: isHead(who.appId, req.userId, req.snapshotId) },
      snapshot: snap ? toSnapshot(snap) : null,
      parent: parent ? toSnapshot(parent) : null,
    })
  })

  /**
   * Approve: an edit awaiting review stays as it is (`applied`); a needs-backend request is taken into the
   * team's backlog (`in-progress`).
   */
  api.post('/admin/requests/:id/approve', (c) => {
    const who = caller(c)
    const req = getRequest(who.appId, c.req.param('id'))
    if (!req) return c.json({ error: 'not found' }, 404)
    const next = req.status === 'pending-review' ? 'applied' : req.status === 'pending-admin' ? 'in-progress' : null
    if (!next) return c.json({ error: `cannot approve a request in status ${req.status}` }, 409)
    patchRequest(req.id, { status: next })
    audited(who, 'request.approve', 'request', req.id, { status: next })
    return c.json({ status: next })
  })

  /** Move the user's head off this request's snapshot (to its parent). */
  const rollback = (appId: string, req: RequestRow): { ok: true } | { ok: false; error: string } => {
    if (!req.snapshotId) return { ok: false, error: 'this request has no applied snapshot' }
    const snap = getSnapshot(appId, req.snapshotId)
    if (!snap?.parentId) return { ok: false, error: 'snapshot has no parent' }
    const head = getHead(appId, req.userId)
    if (head?.snapshotId !== snap.id) return { ok: false, error: 'the user has made other edits since; roll those back first' }
    setHead(appId, req.userId, snap.parentId)
    return { ok: true }
  }

  api.post('/admin/requests/:id/rollback', (c) => {
    const who = caller(c)
    const req = getRequest(who.appId, c.req.param('id'))
    if (!req) return c.json({ error: 'not found' }, 404)
    const r = rollback(who.appId, req)
    if (!r.ok) return c.json({ error: r.error }, 409)
    patchRequest(req.id, { status: 'rolled-back' })
    audited(who, 'request.rollback', 'request', req.id, { userId: req.userId })
    outcome(req.id, 'reverted:admin')
    event(who, 'edit.reverted', req.userId, req.id, { props: { by: 'admin' } })
    return c.json({ status: 'rolled-back' })
  })

  api.post('/admin/requests/:id/reject', async (c) => {
    const who = caller(c)
    const req = getRequest(who.appId, c.req.param('id'))
    if (!req) return c.json({ error: 'not found' }, 404)
    const note = (await c.req.json<{ note?: string }>().catch(() => ({}) as { note?: string })).note ?? null
    // a live edit is also taken back from the user
    const live = isHead(who.appId, req.userId, req.snapshotId)
    if (live) {
      const r = rollback(who.appId, req)
      if (!r.ok) return c.json({ error: r.error }, 409)
    }
    patchRequest(req.id, { status: 'rejected', adminNote: note })
    audited(who, 'request.reject', 'request', req.id, { userId: req.userId, note, rolledBack: live })
    if (live) event(who, 'edit.reverted', req.userId, req.id, { props: { by: 'admin' } })
    return c.json({ status: 'rejected' })
  })

  api.get('/admin/plan', (c) => c.json(planOf(caller(c).appId)))

  /** Set the app's plan and limits as data (F14): `{ plan?: string, limits: { userDailyUsd: 2, ... } }`. */
  api.put('/admin/plan', async (c) => {
    const who = caller(c)
    const b = await c.req.json<{ plan?: unknown; limits?: unknown }>().catch(() => ({}) as { plan?: unknown; limits?: unknown })
    const limits = (b.limits ?? {}) as Record<string, unknown>
    if (typeof limits !== 'object' || Object.values(limits).some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      return c.json({ error: 'limits must map names to non-negative numbers' }, 400)
    }
    const plan = typeof b.plan === 'string' && b.plan ? b.plan : 'custom'
    const row = { appId: who.appId, plan, limits: limits as Record<string, number>, updatedAt: now() }
    db.insert(appPlans).values(row).onConflictDoUpdate({ target: appPlans.appId, set: row }).run()
    audited(who, 'plan.update', 'app', who.appId, { plan, limits })
    return c.json(planOf(who.appId))
  })

  // --- F6 flags, F3 events, F7 audit, F9 export ---

  api.get('/admin/flags', (c) => c.json({ flags: listFlags(db, caller(c).appId) }))

  /** `{ scope: 'app' | 'org' | 'user', scopeId?, key, value }`; `value: null` deletes the override. */
  api.put('/admin/flags', async (c) => {
    const who = caller(c)
    const b = await c.req.json<{ scope?: string; scopeId?: string; key?: string; value?: unknown }>().catch(() => ({}) as Record<string, undefined>)
    if (!FLAG_SCOPES.includes(b.scope as FlagScope)) return c.json({ error: 'scope must be app, org or user' }, 400)
    if (typeof b.key !== 'string' || !b.key || b.key.length > 100) return c.json({ error: 'key is required' }, 400)
    if (b.scope !== 'app' && (typeof b.scopeId !== 'string' || !b.scopeId)) return c.json({ error: 'scopeId is required for org and user flags' }, 400)
    if (b.value === null || b.value === undefined) deleteFlag(db, who.appId, b.scope as FlagScope, b.scopeId ?? '', b.key)
    else setFlag(db, who.appId, b.scope as FlagScope, b.scopeId ?? '', b.key, b.value)
    audited(who, b.value === null || b.value === undefined ? 'flag.delete' : 'flag.set', 'flag', `${b.scope}:${b.scopeId ?? ''}:${b.key}`, { value: b.value ?? null })
    return c.json({ flags: listFlags(db, who.appId) })
  })

  api.get('/admin/events', (c) => {
    const who = caller(c)
    const type = c.req.query('type')
    const since = Number(c.req.query('since') ?? 0) || 0
    const limit = Math.min(Number(c.req.query('limit') ?? 500) || 500, 5000)
    const rows = db
      .select()
      .from(events)
      .where(and(eq(events.appId, who.appId), gte(events.tsMs, since), type ? eq(events.type, type) : undefined))
      .orderBy(desc(events.seq))
      .limit(limit)
      .all()
    return c.json(rows)
  })

  /** The app's audit chain; `?verify=1` recomputes every hash. */
  api.get('/admin/audit', (c) => {
    const who = caller(c)
    const limit = Math.min(Number(c.req.query('limit') ?? 200) || 200, 5000)
    const rows = db.select().from(audit).where(eq(audit.appId, who.appId)).orderBy(desc(audit.seq)).limit(limit).all()
    return c.json({ rows, ...(c.req.query('verify') ? { verify: verifyAuditChain(db, who.appId) } : {}) })
  })

  /** F9: everything about the app, or about one user of it (`?userId=`), as one JSON document. */
  api.get('/admin/export', (c) => {
    const who = caller(c)
    const userId = c.req.query('userId') || null
    audited(who, 'export', userId ? 'user' : 'app', userId ?? who.appId)
    return c.json(buildExport(db, who.appId, userId))
  })

  api.get('/admin/stats', (c) => {
    const who = caller(c)
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000
    const week = db
      .select({ status: requests.status, verdict: requests.verdict, snapshotId: requests.snapshotId })
      .from(requests)
      .where(and(eq(requests.appId, who.appId), gte(requests.createdAtMs, since)))
      .all()
    const total = week.length
    const applied = week.filter((r) => r.snapshotId && ['applied', 'pending-review', 'rolled-back', 'rejected'].includes(r.status)).length
    const needsBackend = week.filter((r) => r.verdict === 'needs-backend').length
    const byStatus: Record<string, number> = {}
    for (const r of week) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    return c.json({
      windowDays: 7,
      total,
      editsThisWeek: applied,
      successRate: total ? applied / total : null,
      needsBackendRate: total ? needsBackend / total : null,
      pendingReview: byStatus['pending-review'] ?? 0,
      moderation: moderationOf(who.appId),
      byStatus,
    })
  })

  // --- C9: the pilot report ---

  /**
   * `GET /v1/report?from=YYYY-MM-DD&to=YYYY-MM-DD` as CSV (`&format=json` for the same rows as JSON). Admin.
   * `&minutesPerEdit=N` overrides the minutes one applied edit saves (`dev_hours_saved`, DECISIONS 75 Р4).
   */
  api.get('/report', (c) => {
    const who = caller(c)
    if (!who.admin) return c.json({ error: 'admin only' }, 403)
    const range = parseRange(c.req.query('from'), c.req.query('to'))
    if ('error' in range) return c.json({ error: range.error }, 400)
    const askedMinutes = c.req.query('minutesPerEdit')
    const minutesPerEdit = askedMinutes === undefined ? (options.reportMinutesPerEdit ?? DEFAULT_MINUTES_PER_EDIT) : parseMinutesPerEdit(askedMinutes)
    if (minutesPerEdit === null) return c.json({ error: `minutesPerEdit must be a number above 0 and at most ${MAX_MINUTES_PER_EDIT}` }, 400)
    const report = buildReport(db, who.appId, range.fromMs, range.toMs, { minutesPerEdit })
    audited(who, 'report', 'app', who.appId, { from: report.from, to: report.to, rows: report.rows.length })
    if (c.req.query('format') === 'json') return c.json(report)
    const name = `pleatkit-report-${who.appId}-${report.from.slice(0, 10)}-${new Date(range.toMs - 1).toISOString().slice(0, 10)}.csv`.replace(/[^\w.-]/g, '_')
    return c.body(reportCsv(report), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` })
  })

  // --- C9: the wish-list map ---

  /**
   * What the zone could not serve: needs-backend, partial and out-of-zone requests of the range (L0, this tenant),
   * newest first, at most `limit` (DECISIONS 70.3: the wish map reads 500 by default).
   */
  const unserved = (appId: string, fromMs: number, toMs: number) =>
    and(
      eq(requests.appId, appId),
      gte(requests.createdAtMs, fromMs),
      sql`${requests.createdAtMs} < ${toMs}`,
      sql`(${requests.verdict} IN ('needs-backend', 'partial', 'not-editable') OR ${requests.intentLabel} = 'out-of-zone')`,
    )
  const wishItems = (appId: string, fromMs: number, toMs: number, limit: number) =>
    db
      .select()
      .from(requests)
      .where(unserved(appId, fromMs, toMs))
      // newest first; rowid orders requests logged in the same millisecond
      .orderBy(desc(requests.createdAtMs), sql`rowid DESC`)
      .limit(limit)
      .all()
      .map((r) => ({
        id: r.id,
        userId: r.userId,
        panel: r.target ?? null,
        kind: r.verdict === 'needs-backend' || r.verdict === 'partial' ? 'needs-backend' : 'out-of-zone',
        verdict: r.verdict,
        intentLabel: r.intentLabel,
        // the gist when retention has blanked the text (DECISIONS 44)
        text: (r.text || r.gist || '').slice(0, 300),
        createdAt: r.createdAt,
      }))

  api.get('/admin/wish-items', (c) => {
    const who = caller(c)
    const range = parseRange(c.req.query('from'), c.req.query('to'))
    if ('error' in range) return c.json({ error: range.error }, 400)
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? WISH_ITEMS_DEFAULT) || WISH_ITEMS_DEFAULT, 1), WISH_ITEMS_MAX)
    const total = db.select({ n: sql<number>`count(*)` }).from(requests).where(unserved(who.appId, range.fromMs, range.toMs)).get()?.n ?? 0
    return c.json({ from: range.fromMs, to: range.toMs, total, items: wishItems(who.appId, range.fromMs, range.toMs, limit) })
  })

  /** The latest wish map, each cluster with its counts from the request log. */
  api.get('/admin/wishes', (c) => {
    const who = caller(c)
    const map = db.select().from(wishMaps).where(eq(wishMaps.appId, who.appId)).orderBy(desc(wishMaps.seq)).limit(1).get()
    if (!map) return c.json({ map: null })
    const all = map.clusters.flatMap((k) => k.requestIds)
    const byId = new Map<string, RequestRow>()
    for (let i = 0; i < all.length; i += 500) {
      for (const r of db.select().from(requests).where(and(eq(requests.appId, who.appId), inArray(requests.id, all.slice(i, i + 500)))).all()) byId.set(r.id, r)
    }
    const clusters = map.clusters.map((k) => {
      const rs = k.requestIds.map((id) => byId.get(id)).filter((r): r is RequestRow => Boolean(r))
      return {
        ...k,
        requests: rs.length,
        users: new Set(rs.map((r) => r.userId)).size,
        lastAt: rs.reduce<string | null>((m, r) => (m && m > r.createdAt ? m : r.createdAt), null),
        examples: rs.slice(0, 3).map((r) => (r.text || r.gist || '').slice(0, 160)),
        statuses: rs.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {}),
      }
    })
    return c.json({ map: { createdAt: map.createdAt, from: map.fromMs, to: map.toMs, provider: map.provider, model: map.model, items: map.items, clusters } })
  })

  /** Store a wish map built by `pleatkit digest` or the agent server (one classifier call over the items). */
  api.put('/admin/wishes', async (c) => {
    const who = caller(c)
    const b = await c.req.json<{ from?: number; to?: number; provider?: string; model?: string; items?: number; clusters?: unknown }>().catch(() => null)
    if (!b || !Array.isArray(b.clusters) || typeof b.from !== 'number' || typeof b.to !== 'number') return c.json({ error: 'from, to and clusters are required' }, 400)
    if (b.clusters.length > 200) return c.json({ error: 'at most 200 clusters' }, 400)
    const clusters: WishCluster[] = []
    for (const k of b.clusters as Record<string, unknown>[]) {
      if (typeof k?.title !== 'string' || typeof k.panel !== 'string' || typeof k.kind !== 'string' || !Array.isArray(k.requestIds)) {
        return c.json({ error: 'each cluster needs panel, title, kind and requestIds' }, 400)
      }
      const requestIds = (k.requestIds as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 500)
      clusters.push({ panel: k.panel.slice(0, 80), title: k.title.slice(0, 120), kind: k.kind === 'needs-backend' ? 'needs-backend' : 'out-of-zone', requestIds })
    }
    const items = typeof b.items === 'number' ? b.items : clusters.reduce((n, k) => n + k.requestIds.length, 0)
    db.insert(wishMaps)
      .values({ appId: who.appId, createdAt: now(), fromMs: b.from, toMs: b.to, provider: typeof b.provider === 'string' ? b.provider : null, model: typeof b.model === 'string' ? b.model : null, items, clusters })
      .run()
    audited(who, 'wishes.build', 'app', who.appId, { clusters: clusters.length, items, model: b.model ?? null })
    return c.json({ clusters: clusters.length }, 201)
  })

  // --- C11: search the code of the users' versions, roll back a selection ---

  /** `?grep=<text>` (plain, case-sensitive) in the live versions, `&scope=all` in every version. Admin or support. */
  api.get('/admin/snapshots', (c) => {
    const who = caller(c)
    const grep = c.req.query('grep')
    const bad = grepError(grep)
    if (bad) return c.json({ error: bad }, 400)
    const scope = c.req.query('scope') === 'all' ? 'all' : 'heads'
    const limit = Math.min(Number(c.req.query('limit') ?? 200) || 200, 1000)
    return c.json({ grep, scope, ...grepSnapshots(db, who.appId, grep!, scope, limit) })
  })

  /**
   * Roll back every live version that contains `grep`, each to the user's nearest earlier version without it.
   * `confirm` must be the number of live versions that match now (what the admin saw); otherwise 409 with the count.
   */
  api.post('/admin/snapshots/rollback', async (c) => {
    const who = caller(c)
    const b = await c.req.json<{ grep?: string; confirm?: number }>().catch(() => ({}) as { grep?: string; confirm?: number })
    const bad = grepError(b.grep)
    if (bad) return c.json({ error: bad }, 400)
    const result = db.transaction(() => {
      const plan = planSelectionRollback(db, who.appId, b.grep!)
      if (b.confirm !== plan.length) return { conflict: plan.length }
      for (const p of plan) if (p.to) setHead(who.appId, p.userId, p.to, getHead(who.appId, p.userId)?.orgId ?? 'default')
      return { plan }
    })
    if ('conflict' in result) {
      return c.json({ error: `confirm must be ${result.conflict}, the number of live versions that match now`, code: 'confirm-count', count: result.conflict }, 409)
    }
    const done = result.plan.filter((p) => p.to)
    for (const p of done) {
      audited(who, 'snapshot.rollback-selection', 'head', p.userId, { from: p.from, to: p.to, grep: b.grep })
      if (p.requestId) {
        event(who, 'edit.reverted', p.userId, p.requestId, { props: { by: 'admin', selection: true } })
        outcome(p.requestId, 'reverted:admin')
      }
    }
    audited(who, 'selection.rollback', 'app', who.appId, { grep: b.grep, matched: result.plan.length, rolledBack: done.length })
    return c.json({ matched: result.plan.length, rolledBack: done.length, skipped: result.plan.filter((p) => !p.to).map((p) => p.userId), users: done.map((p) => p.userId) })
  })

  // --- C10: bulk carry-over after a release, and its rollback ---

  const RELEASE_RE = /^[\w.:-]{6,80}$/
  const ITEM_STATES = ['carried', 'migrated', 'current', 'stale', 'budget', 'failed', 'moved'] as const
  const releaseOf = (appId: string, release: string) => db.select().from(releases).where(and(eq(releases.appId, appId), eq(releases.release, release))).get()
  const itemsOf = (appId: string, release: string) =>
    db
      .select()
      .from(releaseItems)
      .where(and(eq(releaseItems.appId, appId), eq(releaseItems.release, release)))
      .orderBy(releaseItems.userId)
      .all()
  const countsOf = (items: { state: string }[]) => items.reduce<Record<string, number>>((m, i) => ((m[i.state] = (m[i.state] ?? 0) + 1), m), {})

  api.get('/admin/releases', (c) => {
    const who = caller(c)
    const rows = db.select().from(releases).where(eq(releases.appId, who.appId)).orderBy(desc(releases.createdAt)).limit(50).all()
    return c.json(rows.map((r) => ({ ...r, counts: countsOf(itemsOf(who.appId, r.release)) })))
  })

  api.get('/admin/releases/:release', (c) => {
    const who = caller(c)
    const r = releaseOf(who.appId, c.req.param('release'))
    if (!r) return c.json({ error: 'not found' }, 404)
    const items = itemsOf(who.appId, r.release)
    return c.json({ release: { ...r, counts: countsOf(items) }, items })
  })

  /** Start a carry-over run, or resume it with a (new) budget. Returns the run and what is done so far. */
  api.put('/admin/releases/:release', async (c) => {
    const who = caller(c)
    const release = c.req.param('release')
    if (!RELEASE_RE.test(release)) return c.json({ error: 'bad release id' }, 400)
    const b = await c.req.json<{ budgetUsd?: number }>().catch(() => ({}) as { budgetUsd?: number })
    if (typeof b.budgetUsd !== 'number' || !Number.isFinite(b.budgetUsd) || b.budgetUsd < 0) return c.json({ error: 'budgetUsd must be a non-negative number' }, 400)
    const existing = releaseOf(who.appId, release)
    if (existing?.status === 'rolled-back') return c.json({ error: 'this release was rolled back; carry over to it again under a new id', code: 'rolled-back' }, 409)
    const t = now()
    db.insert(releases)
      .values({ appId: who.appId, release, status: 'running', budgetUsd: b.budgetUsd, spentUsd: 0, createdAt: t, updatedAt: t })
      .onConflictDoUpdate({ target: [releases.appId, releases.release], set: { status: 'running', budgetUsd: b.budgetUsd, updatedAt: t } })
      .run()
    audited(who, existing ? 'release.resume' : 'release.start', 'release', release, { budgetUsd: b.budgetUsd })
    const items = itemsOf(who.appId, release)
    return c.json({ release: { ...releaseOf(who.appId, release)!, counts: countsOf(items) }, items }, existing ? 200 : 201)
  })

  /** Record what the carry-over did for one user; the cost adds to the run's spend. */
  api.put('/admin/releases/:release/items/:userId', async (c) => {
    const who = caller(c)
    const release = c.req.param('release')
    const userId = c.req.param('userId')
    const run = releaseOf(who.appId, release)
    if (!run) return c.json({ error: 'start the release first' }, 404)
    if (run.status === 'rolled-back') return c.json({ error: 'this release was rolled back', code: 'rolled-back' }, 409)
    const b = await c.req.json<{ fromSnapshot?: string; toSnapshot?: string | null; state?: string; costUsd?: number; error?: string | null }>().catch(() => null)
    if (!b || typeof b.fromSnapshot !== 'string' || !ITEM_STATES.includes(b.state as (typeof ITEM_STATES)[number])) {
      return c.json({ error: `fromSnapshot and state (${ITEM_STATES.join(', ')}) are required` }, 400)
    }
    const from = getSnapshot(who.appId, b.fromSnapshot)
    if (!from || from.userId !== userId) return c.json({ error: 'fromSnapshot is not a snapshot of this user' }, 400)
    if (b.toSnapshot) {
      const to = getSnapshot(who.appId, b.toSnapshot)
      if (!to || to.userId !== userId) return c.json({ error: 'toSnapshot is not a snapshot of this user' }, 400)
    }
    const cost = typeof b.costUsd === 'number' && Number.isFinite(b.costUsd) && b.costUsd >= 0 ? b.costUsd : 0
    const row = { appId: who.appId, release, userId, fromSnapshot: b.fromSnapshot, toSnapshot: b.toSnapshot ?? null, state: b.state!, error: typeof b.error === 'string' ? b.error.slice(0, 1000) : null, updatedAt: now() }
    db.transaction((tx) => {
      const prev = tx.select().from(releaseItems).where(and(eq(releaseItems.appId, who.appId), eq(releaseItems.release, release), eq(releaseItems.userId, userId))).get()
      // a retried user keeps the cost of the earlier attempts
      const costUsd = (prev?.costUsd ?? 0) + cost
      tx.insert(releaseItems)
        .values({ ...row, costUsd })
        .onConflictDoUpdate({ target: [releaseItems.appId, releaseItems.release, releaseItems.userId], set: { ...row, costUsd } })
        .run()
      tx.update(releases)
        .set({ spentUsd: sql`${releases.spentUsd} + ${cost}`, updatedAt: now() })
        .where(and(eq(releases.appId, who.appId), eq(releases.release, release)))
        .run()
    })
    audited(who, 'release.item', 'release', release, { userId, state: row.state, from: row.fromSnapshot, to: row.toSnapshot, costUsd: cost })
    return c.json({ release: releaseOf(who.appId, release) })
  })

  api.post('/admin/releases/:release/finish', async (c) => {
    const who = caller(c)
    const release = c.req.param('release')
    const run = releaseOf(who.appId, release)
    if (!run) return c.json({ error: 'not found' }, 404)
    if (run.status === 'rolled-back') return c.json({ error: 'this release was rolled back', code: 'rolled-back' }, 409)
    const b = await c.req.json<{ status?: string }>().catch(() => ({}) as { status?: string })
    const status = b.status === 'budget' ? 'budget' : 'done'
    db.update(releases)
      .set({ status, updatedAt: now() })
      .where(and(eq(releases.appId, who.appId), eq(releases.release, release)))
      .run()
    audited(who, 'release.finish', 'release', release, { status, spentUsd: run.spentUsd })
    return c.json({ status })
  })

  /**
   * Roll the release back: every head the carry-over moved goes back to the head before it. A user who has made
   * another edit since keeps their newer version (`kept`); the rest are `rolled-back`.
   */
  api.post('/admin/releases/:release/rollback', (c) => {
    const who = caller(c)
    const release = c.req.param('release')
    if (!releaseOf(who.appId, release)) return c.json({ error: 'not found' }, 404)
    const out = db.transaction(() => {
      const restored: string[] = []
      const kept: string[] = []
      for (const item of itemsOf(who.appId, release)) {
        if (!item.toSnapshot || item.state === 'rolled-back' || item.state === 'kept') continue
        const head = getHead(who.appId, item.userId)
        const next = head?.snapshotId === item.toSnapshot ? 'rolled-back' : 'kept'
        if (next === 'rolled-back') {
          setHead(who.appId, item.userId, item.fromSnapshot, head?.orgId ?? 'default')
          restored.push(item.userId)
        } else kept.push(item.userId)
        db.update(releaseItems)
          .set({ state: next, updatedAt: now() })
          .where(and(eq(releaseItems.appId, who.appId), eq(releaseItems.release, release), eq(releaseItems.userId, item.userId)))
          .run()
      }
      db.update(releases)
        .set({ status: 'rolled-back', rolledBackAt: now(), updatedAt: now() })
        .where(and(eq(releases.appId, who.appId), eq(releases.release, release)))
        .run()
      return { restored, kept }
    })
    for (const u of out.restored) audited(who, 'release.rollback.head', 'head', u, { release })
    audited(who, 'release.rollback', 'release', release, { restored: out.restored.length, kept: out.kept.length })
    return c.json(out)
  })

  // --- DECISIONS 70.2: erasure of a user's or the app's data ---

  /**
   * `DELETE /v1/admin/users/:id` and `DELETE /v1/admin/apps/:id`, admin only (support gets 403 like every admin
   * write). Without `?confirm=` (or with a stale one) nothing is deleted: 409 with what would go and the token
   * for exactly that. With it, everything of the subject goes in one transaction and a tombstone without personal
   * data is appended to the audit chain.
   */
  const erase = async (c: Context<Env>, userId: string | null) => {
    const who = caller(c)
    if (who.viewer) return c.json({ error: 'erase as yourself, not while acting as a user' }, 400)
    const subject = { appId: who.appId, userId }
    const r = await eraseSubject(db, subject, c.req.query('confirm'), extensions)
    if (!r.erased) {
      return c.json({ error: 'confirm with the token for what is there now: ?confirm=<token>', code: 'confirm-required', confirm: r.plan.confirm, counts: r.plan.counts }, 409)
    }
    const tombstone = tombstoneId()
    // the counts and a random id only: the tombstone says that an erasure happened, not whose data it was
    audited(who, userId ? 'erase.user' : 'erase.app', userId ? 'user' : 'app', tombstone, { counts: r.counts })
    return c.json({ erased: true, tombstone, counts: r.counts })
  }
  api.delete('/admin/users/:id', (c) => {
    const id = c.req.param('id')
    if (!id || id.length > 200) return c.json({ error: 'bad user id' }, 400)
    return erase(c, id)
  })
  api.delete('/admin/apps/:id', (c) => {
    if (c.req.param('id') !== caller(c).appId) return c.json({ error: 'an admin erases their own app only' }, 403)
    return erase(c, null)
  })

  // extensions add their routes behind the same auth, body limit, idempotency and admin rules
  const ctx: ExtensionContext = { db, audited: (who, action, objectType, objectId, details = null) => audited(who, action, objectType, objectId, details), place }
  for (const e of extensions) e.routes?.(api, ctx)

  app.route('/v1', api)
  // unversioned routes: the API before /v1 (kept for existing clients; new clients use /v1)
  app.route('/', api)
  return app
}
