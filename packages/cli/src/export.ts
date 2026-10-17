import fs from 'node:fs'
import path from 'node:path'

export interface ExportOptions {
  /** store-server base URL, e.g. http://localhost:8790 */
  store: string
  app: string
  /** Export one user of the app instead of the whole app. */
  user?: string
  /** App key (`mk_live_…`, from MORPHKIT_APP_KEY) or an admin user token. Without one, the development header is sent. */
  key?: string
  /** Output file. Default `morphkit-export-<app>[-<user>]-<date>.json` in the current directory. */
  out?: string
  fetch?: typeof fetch
  cwd?: string
}

/** `morphkit export` (F9): everything store-server keeps for an app, or for one user of it, as one JSON file. */
export async function exportData(o: ExportOptions): Promise<{ ok: boolean; lines: string[]; file?: string }> {
  const base = o.store.replace(/\/$/, '').replace(/\/v1$/, '')
  const url = `${base}/v1/admin/export${o.user ? `?userId=${encodeURIComponent(o.user)}` : ''}`
  const headers: Record<string, string> = { 'x-morphkit-app': o.app, ...(o.key ? { authorization: `Bearer ${o.key}` } : { 'x-morphkit-admin': '1' }) }
  let res: Response
  try {
    res = await (o.fetch ?? globalThis.fetch)(url, { headers })
  } catch (e) {
    return { ok: false, lines: [`could not reach store-server at ${base}: ${(e as Error).message}`] }
  }
  if (!res.ok) return { ok: false, lines: [`store-server answered ${res.status}: ${(await res.text()).slice(0, 300)}`, ...(res.status === 401 ? ['set MORPHKIT_APP_KEY (or pass --key) for a production store'] : [])] }
  const doc = (await res.json()) as Record<string, unknown[] | unknown>
  const day = new Date().toISOString().slice(0, 10)
  const file = path.resolve(o.cwd ?? process.cwd(), o.out ?? `morphkit-export-${o.app}${o.user ? `-${o.user}` : ''}-${day}.json`)
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n')
  const count = (k: string) => (Array.isArray(doc[k]) ? (doc[k] as unknown[]).length : 0)
  const parts = ['snapshots', 'heads', 'requests', 'events', ...(o.user ? [] : ['audit', 'flags'])].map((k) => `${count(k)} ${k}`)
  return { ok: true, file, lines: [`exported ${o.user ? `user ${o.user} of ` : ''}app ${o.app}: ${parts.join(', ')}`, `-> ${file}`] }
}
