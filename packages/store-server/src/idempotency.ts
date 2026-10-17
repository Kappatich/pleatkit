import { createHash } from 'node:crypto'
import { and, eq, lt } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { MiddlewareHandler } from 'hono'
import type { Caller } from './auth.js'
import * as schema from './schema.js'
import { idempotency } from './schema.js'

type Db = BetterSQLite3Database<typeof schema>

/** How long a response is kept for replays. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * F5. A write that carries `Idempotency-Key` runs once per (app, caller, key): a retry with the same method,
 * path and body gets the stored response (`Idempotent-Replayed: true`); the same key with another request is
 * refused with 422. 5xx responses are not stored, so they can be retried.
 */
export function idempotencyMiddleware(db: Db): MiddlewareHandler<{ Variables: { caller: Caller } }> {
  let lastSweep = 0
  return async (c, next) => {
    const key = c.req.header('idempotency-key')
    if (!key || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) return next()
    if (key.length > 200) return c.json({ error: 'Idempotency-Key is longer than 200 characters' }, 400)
    const who = c.get('caller')
    const callerId = who.agent ? `agent:${who.userId ?? ''}` : `user:${who.userId ?? ''}:${who.admin ? 'admin' : ''}`
    const body = await c.req.raw.clone().text()
    const bodyHash = createHash('sha256').update(body).digest('hex')
    const path = new URL(c.req.url).pathname.replace(/^\/v1(?=\/)/, '')
    const now = Date.now()
    if (now - lastSweep > 60_000) {
      lastSweep = now
      db.delete(idempotency).where(lt(idempotency.createdAtMs, now - IDEMPOTENCY_TTL_MS)).run()
    }
    const hit = db
      .select()
      .from(idempotency)
      .where(and(eq(idempotency.appId, who.appId), eq(idempotency.caller, callerId), eq(idempotency.key, key)))
      .get()
    if (hit) {
      if (hit.method !== c.req.method || hit.path !== path || hit.bodyHash !== bodyHash) {
        return c.json({ error: 'this Idempotency-Key was already used for a different request' }, 422)
      }
      return new Response(hit.body === '' ? null : hit.body, {
        status: hit.status,
        headers: { ...(hit.contentType ? { 'content-type': hit.contentType } : {}), 'idempotent-replayed': 'true' },
      })
    }
    await next()
    if (c.res.status >= 500) return
    const text = await c.res.clone().text()
    db.insert(idempotency)
      .values({ appId: who.appId, caller: callerId, key, method: c.req.method, path, bodyHash, status: c.res.status, body: text, contentType: c.res.headers.get('content-type'), createdAtMs: now })
      .onConflictDoNothing()
      .run()
  }
}
