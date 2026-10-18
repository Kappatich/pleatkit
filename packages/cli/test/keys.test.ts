import { describe, expect, it, vi } from 'vitest'
import { isAppKey, publicKeyFromAppKey } from '@pleatkit/runtime/security'
import { keys } from '../src/keys.js'

describe('pleatkit keys', () => {
  it('new: an app key, a JWT secret and the matching public key', async () => {
    const r = await keys('new', {})
    expect(r.ok).toBe(true)
    const env = Object.fromEntries(r.lines.filter((l) => !l.startsWith('#')).map((l) => l.split('=') as [string, string]))
    expect(isAppKey(env.PLEATKIT_APP_KEY)).toBe(true)
    expect(env.PLEATKIT_JWT_SECRET!.length).toBeGreaterThanOrEqual(32)
    expect(env.PLEATKIT_PUBLIC_KEY).toBe(await publicKeyFromAppKey(env.PLEATKIT_APP_KEY!))
  })
  it('public: needs PLEATKIT_APP_KEY', async () => {
    expect((await keys('public', {})).ok).toBe(false)
    const key = 'mk_live_0123456789abcdefghijklmnop'
    expect((await keys('public', { PLEATKIT_APP_KEY: key })).lines).toEqual([await publicKeyFromAppKey(key)])
  })
  it('public: MORPHKIT_APP_KEY still works for one release (DECISIONS 68)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const key = 'mk_live_0123456789abcdefghijklmnop'
    expect((await keys('public', { MORPHKIT_APP_KEY: key })).lines).toEqual([await publicKeyFromAppKey(key)])
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
