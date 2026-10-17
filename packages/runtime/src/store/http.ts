import type { BundleCache, CompiledBundle, RequestLinkPatch, Snapshot, SnapshotStore } from '../types.js'

export interface HttpStoreOptions {
  /** Base URL of @morphkit/store-server, e.g. `/morphkit-store` behind the app's proxy. */
  baseUrl: string
  /** The signed-in user; sent as `x-morphkit-user`. One store instance per user. */
  userId: string
  /** Namespace in a shared store-server. Default `default`. */
  appId?: string
  /** Extra headers (e.g. a real auth token in production). */
  headers?: Record<string, string>
  fetch?: typeof fetch
}

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

  constructor(options: HttpStoreOptions) {
    this.base = options.baseUrl.replace(/\/$/, '')
    this.userId = options.userId
    this.appId = options.appId ?? 'default'
    this.headers = { 'x-morphkit-user': options.userId, 'x-morphkit-app': this.appId, ...options.headers }
    this.fetchFn = options.fetch ?? ((...args) => globalThis.fetch(...args))
  }

  private async request<T>(method: string, path: string, body?: unknown, allow404 = false): Promise<T | null> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: body === undefined ? this.headers : { ...this.headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
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
    await this.request('PUT', `/snapshots/${encodeURIComponent(snapshot.id)}`, snapshot)
  }

  async setHead(userId: string, id: string): Promise<void> {
    this.checkUser(userId)
    await this.request('POST', `/snapshots/${encodeURIComponent(id)}/head`, {})
  }

  bundleCache: BundleCache = {
    get: (hash) => this.request<CompiledBundle>('GET', `/bundles/${encodeURIComponent(hash)}`, undefined, true),
    put: async (hash, bundle) => {
      await this.request('PUT', `/bundles/${encodeURIComponent(hash)}`, bundle)
    },
  }

  async linkRequest(requestId: string, patch: RequestLinkPatch): Promise<void> {
    await this.request('POST', `/requests/${encodeURIComponent(requestId)}/link`, patch)
  }
}
