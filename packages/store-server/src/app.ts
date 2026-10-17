import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { and, desc, eq, gte } from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { Hono, type Context } from 'hono'
import { applyQuotaOps, signingKeyFromAppKey, sriDigest, verifyBundleSignature, type BundleSignature, type QuotaOp } from '@morphkit/runtime/compiler'
import { AuthError, resolveCaller, type AuthOptions, type Caller } from './auth.js'
import { buildExport } from './export.js'
import { deleteFlag, FLAG_SCOPES, listFlags, resolveFlags, setFlag, type FlagScope } from './flags.js'
import { idempotencyMiddleware } from './idempotency.js'
import { appendAudit, EVENT_TYPES, markEditorActive, recordEvent, verifyAuditChain, type EventType } from './ledger.js'
import * as schema from './schema.js'
import { appPlans, appSettings, audit, bundleFiles, events, heads, quotaBuckets, requests, snapshots } from './schema.js'

export type StoreDb = BetterSQLite3Database<typeof schema>

/**
 * Moderation of agent edits (DECISIONS item 15). `off`: an applied edit is just applied. `review`: it is
 * applied for the user at once, but marked `pending-review`; the admin sees it at the top of the list and
 * approves it or rolls it back with one click. (Holding edits until approval is deliberately not built.)
 */
export type Moderation = 'off' | 'review'

export interface StoreAppOptions {
  /** Default for apps whose admin has not chosen (`MORPHKIT_MODERATION`). Default `off`. */
  moderation?: Moderation
  /**
   * Who may call (V1 A1). Default: demo headers only (development and tests). The CLI builds it with
   * `authFromEnv`, which refuses to start in production without an app key and a user-JWT secret.
   */
  auth?: AuthOptions
  /** F2: where this store runs (`MORPHKIT_REGION`), recorded on every row. Default `local`. */
  region?: string
  /** F2: environment recorded when the caller does not say (`MORPHKIT_ENVIRONMENT`). Default `development`. */
  environment?: string
}

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
  return { db: drizzle(sqlite, { schema }), close: () => sqlite.close() }
}

type SnapshotRow = typeof snapshots.$inferSelect
type RequestRow = typeof requests.$inferSelect

/** Wire shape of a snapshot (= `Snapshot` in @morphkit/runtime). */
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
/** What an admin should look at first: edits awaiting review, then backend requests, then the rest. */
const PRIORITY: Record<string, number> = { 'pending-review': 2, 'pending-admin': 1 }
const priority = (status: string) => PRIORITY[status] ?? 0
const now = () => new Date().toISOString()

type Env = { Variables: { caller: Caller } }
const caller = (c: Context<Env>): Caller => c.get('caller')

/** Bundle key of a server-compiled bundle: lowercase hex, the only thing allowed in a public bundle URL. */
const KEY_RE = /^[0-9a-f]{16,64}$/

export function createStoreApp(db: StoreDb, options: StoreAppOptions = {}) {
  const auth: AuthOptions = options.auth ?? { demoHeaders: true }
  if (auth.production && auth.demoHeaders) throw new Error('demo headers are not allowed in production')
  const app = new Hono<Env>()
  const region = options.region ?? 'local'
  const defaultEnvironment = options.environment ?? 'development'
  const place = (who: Caller) => ({ region, environment: who.environment ?? defaultEnvironment })
  /** Actor of an audit row: who did it, as the server authenticated them. */
  const actor = (who: Caller) => (who.agent ? `agent${who.userId ? `:for:${who.userId}` : ''}` : who.admin && !who.userId ? 'admin' : `${who.admin ? 'admin' : 'user'}:${who.userId}`)
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

  api.put('/snapshots/:id', async (c) => {
    const who = caller(c)
    const body = await c.req.json<ReturnType<typeof toSnapshot>>()
    if (body.id !== c.req.param('id')) return c.json({ error: 'id mismatch' }, 400)
    if (!canSee(who, body.userId)) return c.json({ error: 'forbidden' }, 403)
    const existing = getSnapshot(who.appId, body.id)
    if (existing && existing.userId !== body.userId) return c.json({ error: 'forbidden' }, 403)
    if (body.parentId) {
      const parent = getSnapshot(who.appId, body.parentId)
      if (!parent || parent.userId !== body.userId) return c.json({ error: 'parent not found for this user' }, 400)
    }
    const row = {
      id: body.id,
      appId: who.appId,
      userId: body.userId,
      parentId: body.parentId ?? null,
      files: body.files,
      message: body.message ?? '',
      author: body.author,
      createdAt: body.createdAt ?? now(),
      status: body.status,
      baseHash: body.baseHash ?? null,
      requestId: body.requestId ?? null,
      orgId: who.orgId,
      ...place(who),
      baseFiles: body.baseFiles && typeof body.baseFiles === 'object' ? body.baseFiles : null,
      schemaVersion: typeof body.schemaVersion === 'number' ? body.schemaVersion : 1,
    }
    db.insert(snapshots).values(row).onConflictDoUpdate({ target: snapshots.id, set: row }).run()
    audited(who, existing ? 'snapshot.update' : 'snapshot.create', 'snapshot', body.id, { userId: body.userId, parentId: row.parentId, status: row.status, author: row.author, files: Object.keys(row.files ?? {}).length })
    return c.body(null, 204)
  })

  api.post('/snapshots/:id/head', (c) => {
    const who = caller(c)
    const snap = getSnapshot(who.appId, c.req.param('id'))
    if (!snap) return c.json({ error: 'not found' }, 404)
    if (!canSee(who, snap.userId)) return c.json({ error: 'forbidden' }, 403)
    if (snap.status === 'rejected') return c.json({ error: 'a rejected snapshot cannot become the head' }, 409)
    const before = getHead(who.appId, snap.userId)
    const old = before ? getSnapshot(who.appId, before.snapshotId) : undefined
    setHead(who.appId, snap.userId, snap.id, who.orgId)
    audited(who, 'head.set', 'head', snap.userId, { from: before?.snapshotId ?? null, to: snap.id })
    // the user undid an agent edit: its snapshot left the head for its parent (F3)
    if (old?.requestId && old.parentId === snap.id) event(who, 'edit.reverted', snap.userId, old.requestId, { props: { by: 'user' } })
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
        adminNote: null,
        createdAt: t,
        updatedAt: t,
        createdAtMs: Date.now(),
        orgId: who.orgId,
        ...place(who),
        promptVersion: typeof b.promptVersion === 'string' ? b.promptVersion : null,
      })
      .run()
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
      db.update(snapshots).set({ requestId: req.id }).where(eq(snapshots.id, snap.id)).run()
    }
    // under moderation an applied edit stays applied for the user, but waits for the admin's review
    const status = b.status === 'applied' && moderationOf(who.appId) === 'review' ? 'pending-review' : b.status
    patchRequest(req.id, { status, snapshotId: b.snapshotId ?? req.snapshotId, error: b.error ?? null })
    audited(who, 'request.link', 'request', req.id, { status, snapshotId: b.snapshotId ?? null })
    if (status === 'applied' || status === 'pending-review') event(who, 'edit.applied', req.userId, req.id, { dedupeKey: `edit.applied:${req.id}` })
    return c.json({ status })
  })

  // --- admin ---

  const adminOnly = async (c: Context, next: () => Promise<void>) => {
    if (!caller(c).admin) return c.json({ error: 'admin only' }, 403)
    await next()
  }
  api.use('/admin/*', adminOnly)

  api.get('/admin/requests', (c) => {
    const who = caller(c)
    const status = c.req.query('status')
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 1000)
    const rows = db
      .select()
      .from(requests)
      .where(status ? and(eq(requests.appId, who.appId), eq(requests.status, status)) : eq(requests.appId, who.appId))
      .orderBy(desc(requests.createdAtMs))
      .limit(limit)
      .all()
    // edits awaiting review and backend requests first, newest first within each group (stable sort)
    rows.sort((a, b) => priority(b.status) - priority(a.status))
    // the list stays light: no files, log only as a count
    return c.json(rows.map(({ files: _files, log, ...r }) => ({ ...r, toolCalls: log.length, isHead: isHead(who.appId, r.userId, r.snapshotId) })))
  })

  api.get('/admin/settings', (c) => c.json({ moderation: moderationOf(caller(c).appId), default: defaultModeration }))

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

  app.route('/v1', api)
  // unversioned routes: the API before /v1 (kept for existing clients; new clients use /v1)
  app.route('/', api)
  return app
}
