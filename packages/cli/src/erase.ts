export interface EraseOptions {
  /** store-server base URL, e.g. http://localhost:8790 */
  store: string
  app: string
  /** Erase this user of the app; without it, the whole app. */
  user?: string
  /** The token the first run printed: without it nothing is deleted. */
  confirm?: string
  /** App key (`mk_live_…`, from PLEATKIT_APP_KEY) or an admin user token. Without one, the development header is sent. */
  key?: string
  fetch?: typeof fetch
}

/**
 * `pleatkit erase` (DECISIONS 70.2): `DELETE /v1/admin/users/:id` or `/v1/admin/apps/:id` in two steps. The first
 * run shows what store-server would delete and the confirm token for exactly that; the second, with
 * `--confirm <token>`, deletes it and prints the tombstone id to keep with the request (it names no one).
 */
export async function eraseCommand(o: EraseOptions): Promise<{ ok: boolean; erased: boolean; lines: string[] }> {
  const base = o.store.replace(/\/$/, '').replace(/\/v1$/, '')
  const target = o.user ? `users/${encodeURIComponent(o.user)}` : `apps/${encodeURIComponent(o.app)}`
  const url = `${base}/v1/admin/${target}${o.confirm ? `?confirm=${encodeURIComponent(o.confirm)}` : ''}`
  const headers: Record<string, string> = { 'x-pleatkit-app': o.app, ...(o.key ? { authorization: `Bearer ${o.key}` } : { 'x-pleatkit-admin': '1' }) }
  const what = o.user ? `user ${o.user} of app ${o.app}` : `app ${o.app} (every user, the audit chain, settings and plan)`
  let res: Response
  try {
    res = await (o.fetch ?? globalThis.fetch)(url, { method: 'DELETE', headers })
  } catch (e) {
    return { ok: false, erased: false, lines: [`could not reach store-server at ${base}: ${(e as Error).message}`] }
  }
  const body = (await res.json().catch(() => ({}))) as { counts?: Record<string, number>; confirm?: string; tombstone?: string; error?: string }
  const counts = Object.entries(body.counts ?? {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `  ${k}: ${n}`)
  if (res.status === 409 && body.confirm) {
    return {
      ok: !o.confirm,
      erased: false,
      lines: [
        o.confirm ? `the data changed since the token was made; nothing was deleted. Erasing ${what} now deletes:` : `erasing ${what} deletes:`,
        ...(counts.length ? counts : ['  nothing (no rows)']),
        `run again with --confirm ${body.confirm} to erase; this cannot be undone`,
      ],
    }
  }
  if (!res.ok) return { ok: false, erased: false, lines: [`store-server answered ${res.status}: ${body.error ?? ''}`.trim(), ...(res.status === 401 || res.status === 403 ? ['erasing needs an admin: PLEATKIT_APP_KEY (or --key)'] : [])] }
  return { ok: true, erased: true, lines: [`erased ${what}:`, ...(counts.length ? counts : ['  nothing (no rows)']), `audit tombstone ${body.tombstone} (keep it with the request; it names no one)`] }
}
