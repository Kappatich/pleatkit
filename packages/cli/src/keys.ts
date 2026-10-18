import { isAppKey, newAppKey, publicKeyFromAppKey, toBase64Url } from '@pleatkit/runtime/security'
import { pleatkitEnv } from '@pleatkit/runtime/env'

/** `pleatkit keys new | public` (V1 A1, A3). */
export async function keys(sub: string | undefined, env: Record<string, string | undefined>): Promise<{ ok: boolean; lines: string[] }> {
  if (sub === 'new') {
    const appKey = newAppKey('live')
    const secret = toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)))
    return {
      ok: true,
      lines: [
        '# server side only (agent server, store-server, your backend); never commit, never ship to the browser',
        `PLEATKIT_APP_KEY=${appKey}`,
        `PLEATKIT_JWT_SECRET=${secret}`,
        '# public: the app build verifies signed bundles with it (pleatkit({ publicKey }) or PLEATKIT_PUBLIC_KEY)',
        `PLEATKIT_PUBLIC_KEY=${await publicKeyFromAppKey(appKey)}`,
      ],
    }
  }
  if (sub === 'public') {
    const key = pleatkitEnv(env).PLEATKIT_APP_KEY
    if (!isAppKey(key)) return { ok: false, lines: ['Set PLEATKIT_APP_KEY (mk_live_…) in the environment first.'] }
    return { ok: true, lines: [await publicKeyFromAppKey(key)] }
  }
  return { ok: false, lines: ['Usage: pleatkit keys new | public'] }
}
