import type { BundleSignature, QuotaOp, QuotaOutcome } from '@pleatkit/runtime/compiler'
import type { Identity } from './auth.js'

/**
 * The agent server's side of store-server (server to server). With an app key it authenticates as the app
 * (`Authorization: Bearer mk_live_…`) and names the user it acts for; without one (development) it sends the
 * demo headers. Every call is under /v1.
 */
export class StoreClient {
  readonly base: string

  /**
   * @param credentials the app this agent server has an app key for; calls about other apps (development only)
   *   use the demo headers.
   */
  constructor(
    baseUrl: string,
    private readonly credentials: { appId: string; appKey: string } | null,
    private readonly fetchFn: typeof fetch = (...a) => globalThis.fetch(...a),
  ) {
    this.base = baseUrl.replace(/\/$/, '').replace(/\/v1$/, '') + '/v1'
  }

  headers(who: Pick<Identity, 'appId' | 'userId'> & Partial<Pick<Identity, 'orgId' | 'environment'>>, extra: Record<string, string> = {}): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-pleatkit-app': who.appId,
      ...(who.userId ? { 'x-pleatkit-user': who.userId } : {}),
      ...(who.orgId && who.orgId !== 'default' ? { 'x-pleatkit-org': who.orgId } : {}),
      ...(who.environment ? { 'x-pleatkit-env': who.environment } : {}),
      ...(this.credentials && this.credentials.appId === who.appId ? { authorization: `Bearer ${this.credentials.appKey}` } : { 'x-pleatkit-agent': '1' }),
      ...extra,
    }
  }

  async call<T>(method: string, path: string, who: Parameters<StoreClient['headers']>[0], body?: unknown, extra: Record<string, string> = {}, timeoutMs = 5_000): Promise<T> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: this.headers(who, extra),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`store-server ${method} ${path} responded ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`.trim())
    return (res.status === 204 ? null : await res.json()) as T
  }

  /** F6: flags of a user (app < org < user). */
  async flags(who: Pick<Identity, 'appId' | 'userId' | 'orgId'>): Promise<Record<string, unknown>> {
    const q = `?userId=${encodeURIComponent(who.userId)}&orgId=${encodeURIComponent(who.orgId)}`
    return (await this.call<{ flags?: Record<string, unknown> }>('GET', `/flags${q}`, { appId: who.appId, userId: '' })).flags ?? {}
  }

  /** F3: append usage events (dedupe keys make retries safe). */
  events(who: Pick<Identity, 'appId' | 'userId' | 'orgId' | 'environment'>, events: Record<string, unknown>[]): Promise<{ stored: number }> {
    return this.call('POST', '/events', who, { events })
  }

  /** Freeze or unfreeze one user (F6 flag at user scope); the app key is an admin of its app. */
  setUserFlag(who: Pick<Identity, 'appId' | 'userId'>, key: string, value: unknown): Promise<unknown> {
    return this.call('PUT', '/admin/flags', { appId: who.appId, userId: '' }, { scope: 'user', scopeId: who.userId, key, value }, { 'x-pleatkit-admin': '1' })
  }

  /** DECISIONS 42: claim an agent run by its Idempotency-Key, across agent instances. */
  claimRun(who: Pick<Identity, 'appId' | 'userId'>, key: string): Promise<{ state: 'claimed' | 'running' | 'done'; result?: Record<string, unknown> }> {
    return this.call('POST', '/runs/claim', { appId: who.appId, userId: '' }, { userId: who.userId, key })
  }

  /** Store the result of a claimed run, or release the claim (`null`) when it failed. */
  finishRun(who: Pick<Identity, 'appId' | 'userId'>, key: string, result: Record<string, unknown> | null): Promise<null> {
    return this.call('PUT', `/runs/${encodeURIComponent(key)}`, { appId: who.appId, userId: '' }, { userId: who.userId, result })
  }

  quota(appId: string, ops: QuotaOp[]): Promise<QuotaOutcome> {
    return this.call<QuotaOutcome>('POST', '/quota', { appId, userId: '' }, { ops })
  }

  plan(appId: string): Promise<{ plan: string | null; limits: Record<string, number> }> {
    return this.call('GET', '/plan', { appId, userId: '' })
  }

  putBundle(appId: string, key: string, bundle: { js: string; css: string; signature: BundleSignature }): Promise<null> {
    return this.call('PUT', `/bundles/${key}`, { appId, userId: '' }, bundle)
  }

  /** A public bundle file (`<key>.js|css|json`), or null when the store does not have it. */
  async bundleFile(appId: string, file: string): Promise<Response | null> {
    const res = await this.fetchFn(`${this.base}/b/${encodeURIComponent(appId)}/${file}`, { signal: AbortSignal.timeout(5_000) })
    return res.ok ? res : null
  }
}
