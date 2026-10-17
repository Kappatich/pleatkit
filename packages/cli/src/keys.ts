import { isAppKey, newAppKey, publicKeyFromAppKey, toBase64Url } from '@morphkit/runtime/security'

/** `morphkit keys new | public` (V1 A1, A3). */
export async function keys(sub: string | undefined, env: Record<string, string | undefined>): Promise<{ ok: boolean; lines: string[] }> {
  if (sub === 'new') {
    const appKey = newAppKey('live')
    const secret = toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)))
    return {
      ok: true,
      lines: [
        '# server side only (agent server, store-server, your backend); never commit, never ship to the browser',
        `MORPHKIT_APP_KEY=${appKey}`,
        `MORPHKIT_JWT_SECRET=${secret}`,
        '# public: the app build verifies signed bundles with it (morphkit({ publicKey }) or MORPHKIT_PUBLIC_KEY)',
        `MORPHKIT_PUBLIC_KEY=${await publicKeyFromAppKey(appKey)}`,
      ],
    }
  }
  if (sub === 'public') {
    const key = env.MORPHKIT_APP_KEY
    if (!isAppKey(key)) return { ok: false, lines: ['Set MORPHKIT_APP_KEY (mk_live_…) in the environment first.'] }
    return { ok: true, lines: [await publicKeyFromAppKey(key)] }
  }
  return { ok: false, lines: ['Usage: morphkit keys new | public'] }
}
