import { afterEach, describe, expect, it, vi } from 'vitest'
import { authFromEnv, createStoreApp, openStore, resolveCaller } from '../src/index.js'

// The rename morphkit → pleatkit (DECISIONS 68): old env names and request headers work for one release.
const SECRET = 's'.repeat(40)
const APP_KEY = 'mk_live_0123456789abcdefghijklmnop'
const OTHER_KEY = 'mk_live_zyxwvutsrqponmlkjihgfedcba'

const headers = (h: Record<string, string>) => (name: string) => h[name]

describe('store-server under both names', () => {
  afterEach(() => vi.restoreAllMocks())

  it('authFromEnv reads PLEATKIT_* and falls back to MORPHKIT_* with one warning', () => {
    expect(authFromEnv({ NODE_ENV: 'production', PLEATKIT_APP_ID: 'crm', PLEATKIT_APP_KEY: APP_KEY, PLEATKIT_JWT_SECRET: SECRET }).apps).toEqual({ crm: { appKey: APP_KEY, jwtSecret: SECRET } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(authFromEnv({ NODE_ENV: 'production', MORPHKIT_APP_ID: 'crm', MORPHKIT_APP_KEY: APP_KEY, MORPHKIT_JWT_SECRET: SECRET }).apps).toEqual({ crm: { appKey: APP_KEY, jwtSecret: SECRET } })
    expect(authFromEnv({ MORPHKIT_DEMO_HEADERS: '0' }).demoHeaders).toBe(false)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0]![0]).toMatch(/^\[pleatkit\] deprecated environment variables MORPHKIT_APP_ID, MORPHKIT_APP_KEY, MORPHKIT_JWT_SECRET/)
  })

  it('x-morphkit-* request headers are accepted; the new header wins', async () => {
    const auth = { apps: { crm: { appKey: APP_KEY, jwtSecret: SECRET }, other: { appKey: OTHER_KEY, jwtSecret: 't'.repeat(40) } }, demoHeaders: true }
    expect(await resolveCaller(headers({ 'x-morphkit-user': 'alice', 'x-morphkit-admin': '1', 'x-morphkit-app': 'demo' }), auth)).toMatchObject({ appId: 'demo', userId: 'alice', admin: true, via: 'demo' })
    expect(await resolveCaller(headers({ 'x-pleatkit-user': 'bob', 'x-morphkit-user': 'alice', 'x-pleatkit-app': 'demo' }), auth)).toMatchObject({ userId: 'bob' })
    // the old header cannot point an app key at another app either
    await expect(resolveCaller(headers({ authorization: `Bearer ${APP_KEY}`, 'x-morphkit-app': 'other' }), auth)).rejects.toThrow(/another app/)
  })

  it('an old client (x-morphkit-*) reads its head over HTTP', async () => {
    const app = createStoreApp(openStore().db, { auth: { demoHeaders: true } })
    const res = await app.request('http://store.test/v1/heads/alice', { headers: { 'x-morphkit-user': 'alice', 'x-morphkit-app': 'demo' } })
    expect(res.status).toBe(200)
  })
})
