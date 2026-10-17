import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { and, desc, eq, gte } from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { Hono, type Context } from 'hono'
import * as schema from './schema.js'
import { appSettings, bundles, heads, requests, snapshots } from './schema.js'

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
  }
}

const STATUSES = ['proposed', 'applied', 'pending-review', 'rejected', 'pending-admin', 'in-progress', 'rolled-back', 'failed'] as const
/** What an admin should look at first: edits awaiting review, then backend requests, then the rest. */
const PRIORITY: Record<string, number> = { 'pending-review': 2, 'pending-admin': 1 }
const priority = (status: string) => PRIORITY[status] ?? 0
const now = () => new Date().toISOString()

interface Caller {
  appId: string
  userId: string | null
  admin: boolean
  agent: boolean
}

/**
 * Demo authorization: the caller is whoever the `x-morphkit-user` header says, admins send `x-morphkit-admin: 1`,
 * the agent server sends `x-morphkit-agent: 1`. Replace with real auth before production (see README).
 */
function caller(c: Context): Caller {
  return {
    appId: c.req.header('x-morphkit-app') || 'default',
    userId: c.req.header('x-morphkit-user') || null,
    admin: c.req.header('x-morphkit-admin') === '1',
    agent: c.req.header('x-morphkit-agent') === '1',
  }
}

export function createStoreApp(db: StoreDb, options: StoreAppOptions = {}) {
  const app = new Hono()
  const defaultModeration: Moderation = options.moderation ?? 'off'
  const moderationOf = (appId: string): Moderation =>
    (db.select().from(appSettings).where(eq(appSettings.appId, appId)).get()?.moderation as Moderation | undefined) ?? defaultModeration

  const canSee = (who: Caller, userId: string) => who.admin || who.userId === userId
  const getSnapshot = (appId: string, id: string) => db.select().from(snapshots).where(and(eq(snapshots.appId, appId), eq(snapshots.id, id))).get()
  const getHead = (appId: string, userId: string) => db.select().from(heads).where(and(eq(heads.appId, appId), eq(heads.userId, userId))).get()
  const setHead = (appId: string, userId: string, snapshotId: string) =>
    db
      .insert(heads)
      .values({ appId, userId, snapshotId, updatedAt: now() })
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

  /** Public per-app settings (the chat tells the user when edits are reviewed). */
  app.get('/settings', (c) => c.json({ moderation: moderationOf(caller(c).appId) }))

  // --- snapshots & heads (used by HttpStore in the browser) ---

  app.get('/heads/:userId', (c) => {
    const who = caller(c)
    const userId = c.req.param('userId')
    if (!canSee(who, userId)) return c.json({ error: 'forbidden' }, 403)
    const head = getHead(who.appId, userId)
    const snap = head ? getSnapshot(who.appId, head.snapshotId) : undefined
    return c.json({ snapshot: snap ? toSnapshot(snap) : null })
  })

  app.get('/snapshots', (c) => {
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

  app.get('/snapshots/:id', (c) => {
    const who = caller(c)
    const snap = getSnapshot(who.appId, c.req.param('id'))
    if (!snap) return c.json({ error: 'not found' }, 404)
    if (!canSee(who, snap.userId)) return c.json({ error: 'forbidden' }, 403)
    return c.json(toSnapshot(snap))
  })

  app.put('/snapshots/:id', async (c) => {
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
    }
    db.insert(snapshots).values(row).onConflictDoUpdate({ target: snapshots.id, set: row }).run()
    return c.body(null, 204)
  })

  app.post('/snapshots/:id/head', (c) => {
    const who = caller(c)
    const snap = getSnapshot(who.appId, c.req.param('id'))
    if (!snap) return c.json({ error: 'not found' }, 404)
    if (!canSee(who, snap.userId)) return c.json({ error: 'forbidden' }, 403)
    if (snap.status === 'rejected') return c.json({ error: 'a rejected snapshot cannot become the head' }, 409)
    setHead(who.appId, snap.userId, snap.id)
    return c.body(null, 204)
  })

  // --- bundle cache ---

  app.get('/bundles/:hash', (c) => {
    const who = caller(c)
    const row = db
      .select()
      .from(bundles)
      .where(and(eq(bundles.appId, who.appId), eq(bundles.hash, c.req.param('hash'))))
      .get()
    return row ? c.json({ js: row.js, css: row.css }) : c.json({ error: 'not found' }, 404)
  })

  app.put('/bundles/:hash', async (c) => {
    const who = caller(c)
    if (!who.userId && !who.admin) return c.json({ error: 'forbidden' }, 403)
    const { js, css } = await c.req.json<{ js: string; css: string }>()
    if (typeof js !== 'string' || typeof css !== 'string') return c.json({ error: 'js and css are required' }, 400)
    db.insert(bundles)
      .values({ appId: who.appId, hash: c.req.param('hash'), js, css, createdAt: now() })
      .onConflictDoNothing()
      .run()
    return c.body(null, 204)
  })

  // --- request log ---

  app.post('/requests', async (c) => {
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
        adminNote: null,
        createdAt: t,
        updatedAt: t,
        createdAtMs: Date.now(),
      })
      .run()
    return c.json({ id }, 201)
  })

  /** The user's browser reports what happened to the agent's result (committed as a snapshot, or not). */
  app.post('/requests/:id/link', async (c) => {
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
    return c.json({ status })
  })

  // --- admin ---

  const adminOnly = async (c: Context, next: () => Promise<void>) => {
    if (!caller(c).admin) return c.json({ error: 'admin only' }, 403)
    await next()
  }
  app.use('/admin/*', adminOnly)

  app.get('/admin/requests', (c) => {
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

  app.get('/admin/settings', (c) => c.json({ moderation: moderationOf(caller(c).appId), default: defaultModeration }))

  app.put('/admin/settings', async (c) => {
    const who = caller(c)
    const b = await c.req.json<{ moderation?: string }>().catch(() => ({}) as { moderation?: string })
    if (b.moderation !== 'off' && b.moderation !== 'review') return c.json({ error: 'moderation must be "off" or "review"' }, 400)
    db.insert(appSettings)
      .values({ appId: who.appId, moderation: b.moderation, updatedAt: now() })
      .onConflictDoUpdate({ target: appSettings.appId, set: { moderation: b.moderation, updatedAt: now() } })
      .run()
    return c.json({ moderation: b.moderation })
  })

  const isHead = (appId: string, userId: string, snapshotId: string | null) => Boolean(snapshotId) && getHead(appId, userId)?.snapshotId === snapshotId

  app.get('/admin/requests/:id', (c) => {
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
  app.post('/admin/requests/:id/approve', (c) => {
    const who = caller(c)
    const req = getRequest(who.appId, c.req.param('id'))
    if (!req) return c.json({ error: 'not found' }, 404)
    const next = req.status === 'pending-review' ? 'applied' : req.status === 'pending-admin' ? 'in-progress' : null
    if (!next) return c.json({ error: `cannot approve a request in status ${req.status}` }, 409)
    patchRequest(req.id, { status: next })
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

  app.post('/admin/requests/:id/rollback', (c) => {
    const who = caller(c)
    const req = getRequest(who.appId, c.req.param('id'))
    if (!req) return c.json({ error: 'not found' }, 404)
    const r = rollback(who.appId, req)
    if (!r.ok) return c.json({ error: r.error }, 409)
    patchRequest(req.id, { status: 'rolled-back' })
    return c.json({ status: 'rolled-back' })
  })

  app.post('/admin/requests/:id/reject', async (c) => {
    const who = caller(c)
    const req = getRequest(who.appId, c.req.param('id'))
    if (!req) return c.json({ error: 'not found' }, 404)
    const note = (await c.req.json<{ note?: string }>().catch(() => ({}) as { note?: string })).note ?? null
    // a live edit is also taken back from the user
    if (isHead(who.appId, req.userId, req.snapshotId)) {
      const r = rollback(who.appId, req)
      if (!r.ok) return c.json({ error: r.error }, 409)
    }
    patchRequest(req.id, { status: 'rejected', adminNote: note })
    return c.json({ status: 'rejected' })
  })

  app.get('/admin/stats', (c) => {
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

  return app
}
