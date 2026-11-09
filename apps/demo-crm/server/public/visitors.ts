import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { Hono } from 'hono'
import { createStoreApp, openStore } from '@pleatkit/store-server'
import { createApp as createDataApp } from '../app.js'

/** One recent request of a visitor, for the derived events (rephrase, repeat). */
export interface RecentRequest {
  text: string
  words: Set<string>
  chip: boolean
  at: number
}

/**
 * A visitor's sandbox: their own store namespace (`appId`), their own SQLite file in their own folder, and their own
 * copy of the CRM data. Nothing here is shared between visitors; the folder is deleted after the TTL.
 */
export interface Visitor {
  /** The cookie value (128 random bits); never logged. */
  readonly id: string
  /** sha256 of the cookie, 16 hex: the id in the logs. */
  readonly hash: string
  /** The store and agent namespace: `v<hash>`. Every request of this visitor is forced into it. */
  readonly appId: string
  readonly createdAt: number
  readonly dir: string
  lastSeen: number
  /** Requests sent in this session (the sequence number in the log). */
  seq: number
  recent: RecentRequest[]
  /** Request ids of this visitor's runs (feedback is accepted only for these). */
  requestIds: Set<string>
  data: Hono
  store: { app: { fetch: (req: Request) => Response | Promise<Response> }; close: () => void; lastUsed: number } | null
}

export const COOKIE = 'pk_demo'
/** Readable by the page: the visitor's namespace (`v<hash>`), which server-compiled bundles are built for. */
export const APP_COOKIE = 'pk_demo_app'
const ID = /^[A-Za-z0-9_-]{22,64}$/

export const hashOf = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16)

export class Visitors {
  private readonly byId = new Map<string, Visitor>()
  private readonly byApp = new Map<string, Visitor>()

  constructor(
    private readonly options: { stateDir: string; ttlMs: number; maxVisitors: number; maxOpenStores?: number; idleCloseMs?: number },
  ) {
    // the whole store is per process: whatever an earlier run left is wiped
    fs.rmSync(path.join(options.stateDir, 'visitors'), { recursive: true, force: true })
    fs.mkdirSync(path.join(options.stateDir, 'visitors'), { recursive: true })
  }

  get size(): number {
    return this.byId.size
  }

  /** The visitor of this cookie value, or null (unknown, expired or malformed). */
  get(cookie: string | undefined): Visitor | null {
    if (!cookie || !ID.test(cookie)) return null
    const v = this.byId.get(cookie)
    if (!v) return null
    if (Date.now() - v.createdAt > this.options.ttlMs) {
      this.remove(v)
      return null
    }
    v.lastSeen = Date.now()
    return v
  }

  /**
   * A visitor for this cookie value: the known one, or a fresh sandbox. A cookie the server does not know (expired,
   * or from before a restart) gets a new empty sandbox under the same id.
   */
  ensure(cookie: string | undefined): { visitor: Visitor; created: boolean } {
    const known = this.get(cookie)
    if (known) return { visitor: known, created: false }
    const id = cookie && ID.test(cookie) ? cookie : randomBytes(16).toString('base64url')
    if (this.byId.size >= this.options.maxVisitors) {
      // the least recently seen sandbox goes first
      const oldest = [...this.byId.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0]
      if (oldest) this.remove(oldest)
    }
    const hash = hashOf(id)
    const appId = `v${hash}`
    const dir = path.join(this.options.stateDir, 'visitors', appId)
    const now = Date.now()
    const visitor: Visitor = { id, hash, appId, createdAt: now, lastSeen: now, dir, seq: 0, recent: [], requestIds: new Set(), data: createDataApp(), store: null }
    this.byId.set(id, visitor)
    this.byApp.set(appId, visitor)
    return { visitor, created: true }
  }

  byAppId(appId: string | null | undefined): Visitor | null {
    return appId ? (this.byApp.get(appId) ?? null) : null
  }

  /** The visitor's store-server, opened on first use (their own SQLite file under their own folder). */
  storeOf(v: Visitor): { fetch: (req: Request) => Response | Promise<Response> } {
    if (!v.store) {
      fs.mkdirSync(v.dir, { recursive: true })
      const { db, close } = openStore({ file: path.join(v.dir, 'store.db') })
      // development headers are safe here: the store is reachable only through the gateway, which forces the
      // visitor's own app id on every call and strips every other identity header
      const app = createStoreApp(db, { auth: { demoHeaders: true }, region: 'demo', environment: 'demo', bodyLimitBytes: 1024 * 1024 })
      v.store = { app, close, lastUsed: Date.now() }
      this.closeIdle()
    }
    v.store.lastUsed = Date.now()
    return v.store.app
  }

  /** Keep at most `maxOpenStores` SQLite handles; idle ones are closed (the file stays and reopens on demand). */
  private closeIdle(): void {
    const max = this.options.maxOpenStores ?? 64
    const idle = this.options.idleCloseMs ?? 10 * 60_000
    const open = [...this.byId.values()].filter((v) => v.store).sort((a, b) => a.store!.lastUsed - b.store!.lastUsed)
    let count = open.length
    for (const v of open) {
      if (count <= max && Date.now() - v.store!.lastUsed < idle) break
      v.store!.close()
      v.store = null
      count--
    }
  }

  private remove(v: Visitor): void {
    v.store?.close()
    v.store = null
    this.byId.delete(v.id)
    this.byApp.delete(v.appId)
    fs.rmSync(v.dir, { recursive: true, force: true })
  }

  /** Delete every sandbox older than the TTL and close idle store handles. Returns how many were deleted. */
  sweep(): number {
    let n = 0
    for (const v of [...this.byId.values()]) {
      if (Date.now() - v.createdAt > this.options.ttlMs) {
        this.remove(v)
        n++
      }
    }
    this.closeIdle()
    return n
  }

  closeAll(): void {
    for (const v of this.byId.values()) v.store?.close()
  }
}
