import { useCallback } from 'react'
import { AGENT_URL, AUTH, STORE_URL, tokenFor } from './pleatkit'

export type AdminCall = <T>(path: string, init?: RequestInit) => Promise<T>

/** Admin auth: `?auth=token` gets an admin token from the demo's backend; otherwise the development header. */
async function adminAuth(): Promise<Record<string, string>> {
  return AUTH === 'token' ? { authorization: `Bearer ${await tokenFor('admin', 'admin')}` } : { 'x-pleatkit-admin': '1' }
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}

/** store-server's /v1 API as the app's admin. */
export function useAdminApi(appId: string): AdminCall {
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const res = await fetch(`${STORE_URL}/v1${path}`, { ...init, headers: { ...(await adminAuth()), 'x-pleatkit-app': appId, 'content-type': 'application/json', ...init?.headers } })
      return json<T>(res)
    },
    [appId],
  )
}

/** The agent server's admin routes (the expected cost of an edit). */
export function useAgentAdmin(appId: string): AdminCall {
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const res = await fetch(`${AGENT_URL}/v1${path}`, { ...init, headers: { ...(await adminAuth()), 'content-type': 'application/json', ...init?.headers }, body: init?.body ?? JSON.stringify({ appId }) })
      return json<T>(res)
    },
    [appId],
  )
}
