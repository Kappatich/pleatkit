import type { BundleCache, CompiledBundle, Moderation, RequestLinkPatch, RequestLinkResult, Snapshot, SnapshotStore } from '../types.js'

export interface HttpStoreOptions {
  /** Base URL of @morphkit/store-server, e.g. `/morphkit-store` behind the app's proxy. */
  baseUrl: string
  /** The signed-in user; sent as `x-morphkit-user`. One store instance per user. */
  userId: string
  /** Namespace in a shared store-server. Default `default`. */
  appId?: string
  /**
   * User token for production (V1 A1): an HS256 JWT minted by your backend with `mintUserToken` (15 minutes at
   * most), or a function that returns a fresh one. Sent as `Authorization: Bearer …`; without it the store
   * falls back to the demo header `x-morphkit-user`, which store-server accepts only in development.
   */
  token?: string | (() => string | Promise<string>)
  /** Extra headers. */
  headers?: Record<string, string>
  fetch?: typeof fetch
}

const newKey = (): string => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

export class HttpStoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpStoreError'
  }
}

/**
 * SnapshotStore backed by @morphkit/store-server over HTTP: snapshots, heads and compiled bundles live on
 * the server, so a user's version follows them across browsers and admins can see and roll back edits.
 * Demo auth only (`x-morphkit-user` header); see the README.
 */
export class HttpStore implements SnapshotStore {
  readonly userId: string
  readonly appId: string
  private readonly base: string
  private readonly headers: Record<string, string>
  private readonly fetchFn: typeof fetch
  private readonly token: HttpStoreOptions['token']

  constructor(options: HttpStoreOptions) {
    // the versioned API (F4); a base URL that already ends in /v1 is taken as it is
    this.base = options.baseUrl.replace(/\/$/, '').replace(/\/v1$/, '') + '/v1'
    this.userId = options.userId
    this.appId = options.appId ?? 'default'
    this.token = options.token
    this.headers = { ...(options.token ? {} : { 'x-morphkit-user': options.userId }), 'x-morphkit-app': this.appId, ...options.headers }
    this.fetchFn = options.fetch ?? ((...args) => globalThis.fetch(...args))
  }

  /** Headers of every request: the app, and the user token when there is one. */
  async authHeaders(): Promise<Record<string, string>> {
    const token = typeof this.token === 'function' ? await this.token() : this.token
    return token ? { ...this.headers, authorization: `Bearer ${token}` } : { ...this.headers }
  }

  /**
   * Writes carry an `Idempotency-Key` (F5) and are retried once after a network error with the same key, so a
   * flaky connection never applies a write twice.
   */
  private async request<T>(method: string, path: string, body?: unknown, allow404 = false, idempotencyKey?: string): Promise<T | null> {
    const headers = await this.authHeaders()
    const init: RequestInit = {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }
    let res: Response
    try {
      res = await this.fetchFn(`${this.base}${path}`, init)
    } catch (e) {
      if (!idempotencyKey) throw e
      res = await this.fetchFn(`${this.base}${path}`, init)
    }
    if (allow404 && res.status === 404) return null
    if (!res.ok) throw new HttpStoreError(res.status, `${method} ${path} failed: ${res.status} ${await res.text().catch(() => '')}`.trim())
    if (res.status === 204) return null
    return (await res.json()) as T
  }

  private checkUser(userId: string): void {
    if (userId !== this.userId) throw new Error(`HttpStore is bound to user "${this.userId}", not "${userId}"`)
  }

  async head(userId: string): Promise<Snapshot | null> {
    this.checkUser(userId)
    const r = await this.request<{ snapshot: Snapshot | null }>('GET', `/heads/${encodeURIComponent(userId)}`)
    return r?.snapshot ?? null
  }

  async get(id: string): Promise<Snapshot> {
    const s = await this.request<Snapshot>('GET', `/snapshots/${encodeURIComponent(id)}`, undefined, true)
    if (!s) throw new Error(`Snapshot ${id} not found`)
    return s
  }

  async list(userId: string, limit = 50): Promise<Snapshot[]> {
    this.checkUser(userId)
    return (await this.request<Snapshot[]>('GET', `/snapshots?userId=${encodeURIComponent(userId)}&limit=${limit}`)) ?? []
  }

  async put(snapshot: Snapshot): Promise<void> {
    await this.request('PUT', `/snapshots/${encodeURIComponent(snapshot.id)}`, snapshot, false, `snapshot:${snapshot.id}:${snapshot.status}`)
  }

  async setHead(userId: string, id: string): Promise<void> {
    this.checkUser(userId)
    await this.request('POST', `/snapshots/${encodeURIComponent(id)}/head`, {}, false, `head:${id}:${newKey()}`)
  }

  bundleCache: BundleCache = {
    get: (hash) => this.request<CompiledBundle>('GET', `/bundles/${encodeURIComponent(hash)}`, undefined, true),
    put: async (hash, bundle) => {
      await this.request('PUT', `/bundles/${encodeURIComponent(hash)}`, bundle, false, `bundle:${hash}`)
    },
  }

  /** Returns the request's final status: `pending-review` when the app runs with `moderation: 'review'`. */
  async linkRequest(requestId: string, patch: RequestLinkPatch): Promise<RequestLinkResult | null> {
    return this.request<RequestLinkResult>('POST', `/requests/${encodeURIComponent(requestId)}/link`, patch, false, `link:${requestId}:${patch.status}:${patch.snapshotId ?? ''}`)
  }

  /** Flags for this user (F6): the kill switch `morphkit.enabled`, `edits.enabled`, and the app's own. */
  async flags(): Promise<Record<string, unknown>> {
    const r = await this.request<{ flags: Record<string, unknown> }>('GET', '/flags')
    return r?.flags ?? {}
  }

  /** The app's moderation mode (`off` or `review`), as set by its admin. */
  async moderation(): Promise<Moderation> {
    const r = await this.request<{ moderation: Moderation }>('GET', '/settings')
    return r?.moderation ?? 'off'
  }
}
