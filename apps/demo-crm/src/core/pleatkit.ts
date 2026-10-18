import * as config from 'virtual:pleatkit'
import { HttpStore, LocalStore, type SnapshotStore } from '@pleatkit/runtime'

export const pleatkitConfig = config
export const USERS = ['alice', 'bob'] as const
export type UserId = (typeof USERS)[number]

const params = new URLSearchParams(location.search)
/** Store namespace in store-server; `?app=` lets tests run in isolation. */
export const APP_ID = params.get('app') ?? 'demo-crm'
/** `?store=local` keeps everything in this browser (IndexedDB); default is store-server (needed for /admin). */
export const STORE_KIND: 'http' | 'local' = params.get('store') === 'local' ? 'local' : 'http'
export const STORE_URL = '/pleatkit-store'
export const AGENT_URL = '/agent'
/** Signed server bundles, proxied to store-server's /v1/b (V1 B1). */
export const BUNDLE_URL = '/pleatkit/b'
/** `?compile=browser`: esbuild-wasm in the page instead of the agent server (the plugin's default is `server`). */
export const COMPILE: 'browser' | 'server' | null = params.get('compile') === 'browser' ? 'browser' : params.get('compile') === 'server' ? 'server' : null

/**
 * `?auth=token`: the production path (V1 A1). The demo's backend mints a 15-minute user token
 * (`/api/pleatkit-token`), and store-server and the agent server verify it. Without it the demo uses the
 * development headers, which store-server accepts only outside production.
 */
export const AUTH: 'token' | 'headers' = params.get('auth') === 'token' ? 'token' : 'headers'

const tokens = new Map<string, Promise<{ token: string; publicKey: string | null; at: number }>>()

async function fetchToken(user: string, role: 'user' | 'support' | 'admin') {
  const res = await fetch(`/api/pleatkit-token?user=${encodeURIComponent(user)}&role=${role}&app=${encodeURIComponent(APP_ID)}`)
  if (!res.ok) throw new Error(`could not get a pleatkit token: ${res.status}`)
  return { ...((await res.json()) as { token: string; publicKey: string | null }), at: Date.now() }
}

/** A fresh user token (refreshed after 10 minutes, or at once with `force` after a 401; tokens live 15). */
export async function tokenFor(user: string, role: 'user' | 'support' | 'admin' = 'user', force = false): Promise<string> {
  const key = `${role}:${user}`
  let hit = tokens.get(key)
  if (force || !hit || Date.now() - (await hit.catch(() => ({ at: 0 }))).at > 600_000) tokens.set(key, (hit = fetchToken(user, role)))
  return (await hit).token
}

/**
 * The key bundles must be signed with, in `?auth=token` mode. A real app bakes it into the build
 * (`pleatkit({ publicKey })`); the demo gets it from its backend so other demo modes keep working unsigned.
 */
export async function demoPublicKey(): Promise<string | null> {
  if (AUTH !== 'token') return null
  return (await (tokens.get('user:alice') ?? fetchToken('alice', 'user'))).publicKey
}

const local = new LocalStore('pleatkit-demo-crm')
const http = new Map<string, HttpStore>()

/**
 * `?as=support` (C8, opened from /admin's "View as"): the demo's support person acts as the user. In `?auth=token`
 * mode with a support token, otherwise with the development headers (`x-pleatkit-role: support`).
 */
export const VIEWER: string | null = params.get('as') === 'support' ? 'support' : null

/** One store per user: a user token in `?auth=token` mode, otherwise the development header. */
export function storeFor(user: UserId): SnapshotStore {
  if (STORE_KIND === 'local') return local
  const key = VIEWER ? `${VIEWER}>${user}` : user
  let s = http.get(key)
  if (!s) {
    const token = VIEWER ? (o?: { refresh?: boolean }) => tokenFor(VIEWER!, 'support', o?.refresh) : (o?: { refresh?: boolean }) => tokenFor(user, 'user', o?.refresh)
    s = new HttpStore({
      baseUrl: STORE_URL,
      userId: user,
      appId: APP_ID,
      ...(AUTH === 'token' ? { token } : {}),
      ...(VIEWER ? { viewer: VIEWER, ...(AUTH === 'token' ? {} : { headers: { 'x-pleatkit-role': 'support' } }) } : {}),
    })
    http.set(key, s)
  }
  return s
}
