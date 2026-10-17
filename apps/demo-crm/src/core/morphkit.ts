import * as config from 'virtual:morphkit'
import { HttpStore, LocalStore, type SnapshotStore } from '@morphkit/runtime'

export const morphkitConfig = config
export const USERS = ['alice', 'bob'] as const
export type UserId = (typeof USERS)[number]

const params = new URLSearchParams(location.search)
/** Store namespace in store-server; `?app=` lets tests run in isolation. */
export const APP_ID = params.get('app') ?? 'demo-crm'
/** `?store=local` keeps everything in this browser (IndexedDB); default is store-server (needed for /admin). */
export const STORE_KIND: 'http' | 'local' = params.get('store') === 'local' ? 'local' : 'http'
export const STORE_URL = '/morphkit-store'
export const AGENT_URL = '/agent'

const local = new LocalStore('morphkit-demo-crm')
const http = new Map<string, HttpStore>()

/** One store per user: HttpStore sends the user in a header (demo auth). */
export function storeFor(user: UserId): SnapshotStore {
  if (STORE_KIND === 'local') return local
  let s = http.get(user)
  if (!s) http.set(user, (s = new HttpStore({ baseUrl: STORE_URL, userId: user, appId: APP_ID })))
  return s
}
