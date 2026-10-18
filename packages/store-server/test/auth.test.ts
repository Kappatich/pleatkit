import { describe, expect, it } from 'vitest'
import { HttpStore, type Snapshot } from '@pleatkit/runtime'
import { signBundle, signingKeyFromAppKey, sriDigest } from '@pleatkit/runtime/security'
import { authFromEnv, createStoreApp, mintUserToken, openStore } from '../src/index.js'
import { mintUserToken as fromTokenEntry } from '../src/token.js'

const SECRET = 's'.repeat(40)
const APP_KEY = 'mk_live_0123456789abcdefghijklmnop'
const OTHER_KEY = 'mk_live_zyxwvutsrqponmlkjihgfedcba'
const apps = { crm: { appKey: APP_KEY, jwtSecret: SECRET }, other: { appKey: OTHER_KEY, jwtSecret: 't'.repeat(40) } }

const secureApp = () => createStoreApp(openStore().db, { auth: { apps, demoHeaders: true } })
const call = (app: ReturnType<typeof createStoreApp>, path: string, headers: Record<string, string>, init: RequestInit = {}) =>
  app.request(`http://store.test${path}`, { ...init, headers: { 'content-type': 'application/json', ...headers } })
const userToken = (userId: string, extra: Partial<Parameters<typeof mintUserToken>[0]> = {}) => mintUserToken({ secret: SECRET, userId, appId: 'crm', ...extra })

const snap = (id: string, userId: string, parentId: string | null): Snapshot => ({
  id,
  parentId,
  userId,
  files: { 'src/dynamic/card.tsx': 'export default () => null' },
  message: id,
  author: parentId ? 'agent' : 'base',
  createdAt: new Date().toISOString(),
  status: 'applied',
})

describe('production refuses to start without credentials (V1 A1)', () => {
  it('authFromEnv', () => {
    expect(() => authFromEnv({ NODE_ENV: 'production' })).toThrow(/refusing to start/)
    expect(() => authFromEnv({ NODE_ENV: 'production', PLEATKIT_APP_KEY: 'sk-123', PLEATKIT_JWT_SECRET: SECRET })).toThrow(/mk_live_/)
    expect(() => authFromEnv({ NODE_ENV: 'production', PLEATKIT_APP_KEY: APP_KEY, PLEATKIT_JWT_SECRET: 'short' })).toThrow(/32 characters/)
    expect(() => authFromEnv({ PLEATKIT_APPS: '{not json' })).toThrow(/PLEATKIT_APPS/)
    const prod = authFromEnv({ NODE_ENV: 'production', PLEATKIT_APP_ID: 'crm', PLEATKIT_APP_KEY: APP_KEY, PLEATKIT_JWT_SECRET: SECRET, PLEATKIT_DEMO_HEADERS: '1' })
    expect(prod).toMatchObject({ production: true, demoHeaders: false, apps: { crm: { appKey: APP_KEY } } })
    expect(authFromEnv({})).toMatchObject({ production: false, demoHeaders: true, apps: {} })
    expect(authFromEnv({ PLEATKIT_DEMO_HEADERS: '0' }).demoHeaders).toBe(false)
    expect(() => createStoreApp(openStore().db, { auth: { production: true, demoHeaders: true } })).toThrow(/production/)
  })

  it('without demo headers every route but /health and public bundles needs a token', async () => {
    const app = createStoreApp(openStore().db, { auth: authFromEnv({ NODE_ENV: 'production', PLEATKIT_APP_ID: 'crm', PLEATKIT_APP_KEY: APP_KEY, PLEATKIT_JWT_SECRET: SECRET }) })
    expect((await app.request('http://store.test/health')).status).toBe(200)
    expect((await call(app, '/v1/heads/alice', { 'x-pleatkit-user': 'alice', 'x-pleatkit-app': 'crm' })).status).toBe(401)
    expect((await call(app, '/v1/admin/requests', { 'x-pleatkit-admin': '1' })).status).toBe(401)
    expect((await call(app, '/v1/heads/alice', { authorization: `Bearer ${await userToken('alice')}` })).status).toBe(200)
  })
})

describe('user tokens and app keys', () => {
  it('a user token reads and writes only its own user; demo headers are refused for an app with credentials', async () => {
    const app = secureApp()
    const fetchVia = (input: string | URL | Request, init?: RequestInit) => app.request(input instanceof Request ? input : String(input), init)
    const alice = new HttpStore({ baseUrl: 'http://store.test/v1', userId: 'alice', appId: 'crm', token: () => userToken('alice'), fetch: fetchVia as typeof fetch })
    const base = snap('01A', 'alice', null)
    await alice.put(base)
    await alice.setHead('alice', base.id)
    expect((await alice.head('alice'))?.id).toBe(base.id)

    const bobToken = await userToken('bob')
    expect((await call(app, '/v1/heads/alice', { authorization: `Bearer ${bobToken}` })).status).toBe(403)
    expect((await call(app, '/v1/heads/alice', { 'x-pleatkit-user': 'alice', 'x-pleatkit-app': 'crm' })).status).toBe(401)
    // the same token for another app, a token of another app's secret, an expired token
    expect((await call(app, '/v1/heads/alice', { authorization: `Bearer ${await userToken('alice')}`, 'x-pleatkit-app': 'other' })).status).toBe(401)
    const expired = await userToken('alice', { now: Date.now() / 1000 - 3600 })
    expect((await call(app, '/v1/heads/alice', { authorization: `Bearer ${expired}` })).status).toBe(401)
    // apps without credentials still work with demo headers in development
    expect((await call(app, '/v1/heads/alice', { 'x-pleatkit-user': 'alice', 'x-pleatkit-app': 'demo' })).status).toBe(200)
    expect(fromTokenEntry).toBe(mintUserToken)
  })

  it('admin routes need role admin; the app key acts for the agent and the admin', async () => {
    const app = secureApp()
    expect((await call(app, '/v1/admin/requests', { authorization: `Bearer ${await userToken('alice')}` })).status).toBe(403)
    expect((await call(app, '/v1/admin/requests', { authorization: `Bearer ${await userToken('root', { role: 'admin' })}` })).status).toBe(200)
    const logged = await call(app, '/v1/requests', { authorization: `Bearer ${APP_KEY}`, 'x-pleatkit-user': 'alice' }, { method: 'POST', body: JSON.stringify({ userId: 'alice', text: 'x', log: [] }) })
    expect(logged.status).toBe(201)
    expect((await call(app, '/v1/admin/requests', { authorization: `Bearer ${APP_KEY}` })).status).toBe(200)
    expect((await call(app, '/v1/admin/requests', { authorization: `Bearer ${APP_KEY}`, 'x-pleatkit-app': 'other' })).status).toBe(403)
    expect((await call(app, '/v1/admin/requests', { authorization: 'Bearer mk_live_doesnotexistdoesnotexist00' })).status).toBe(401)
    // users cannot log requests (only the agent server can)
    const asUser = await call(app, '/v1/requests', { authorization: `Bearer ${await userToken('alice')}` }, { method: 'POST', body: JSON.stringify({ userId: 'bob', text: 'x' }) })
    expect(asUser.status).toBe(403)
  })
})

describe('bundles: signed server bundles are public, browser bundles stay private (V1 A3, B1)', () => {
  async function signed(key: string, js: string, css = '') {
    const sk = await signingKeyFromAppKey(APP_KEY)
    return signBundle({ v: 1, app: 'crm', key, filesHash: 'f'.repeat(64), js: await sriDigest(js), css: await sriDigest(css), externals: ['react'], compiler: 't', createdAt: 'now' }, sk)
  }
  const KEY = 'a1'.repeat(20)

  it('the agent stores a signed bundle; anyone can load it by key from /v1/b/<app>/<key>.js', async () => {
    const app = secureApp()
    const js = 'export const modules = {}'
    const put = (body: unknown, key = KEY) => call(app, `/v1/bundles/${key}`, { authorization: `Bearer ${APP_KEY}` }, { method: 'PUT', body: JSON.stringify(body) })
    // unsigned, or signed with the wrong digest, or by another key: refused
    expect((await put({ js, css: '' })).status).toBe(400)
    expect((await put({ js: js + ' ', css: '', signature: await signed(KEY, js) })).status).toBe(400)
    const otherSk = await signingKeyFromAppKey(OTHER_KEY)
    const foreign = await signBundle((await signed(KEY, js)).payload, otherSk)
    expect((await put({ js, css: '', signature: foreign })).status).toBe(400)
    expect((await put({ js, css: '', signature: await signed(KEY, js) })).status).toBe(204)

    const res = await app.request(`http://store.test/v1/b/crm/${KEY}.js`)
    expect(res.headers.get('content-type')).toMatch(/text\/javascript/)
    expect(res.headers.get('cache-control')).toMatch(/immutable/)
    // isolated panels load bundles from an opaque-origin iframe
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(await res.text()).toBe(js)
    const sig = (await (await app.request(`http://store.test/v1/b/crm/${KEY}.json`)).json()) as { sig: string }
    expect(sig.sig).toBeTruthy()
    expect((await app.request(`http://store.test/v1/b/other/${KEY}.js`)).status).toBe(404)
    expect((await app.request(`http://store.test/v1/b/crm/..%2Fsecret.js`)).status).toBe(404)
  })

  it('a bundle uploaded by one user is never served to another (no cache poisoning)', async () => {
    const app = createStoreApp(openStore().db)
    const as = (user: string) => ({ 'x-pleatkit-user': user, 'x-pleatkit-app': 'crm' })
    const put = await call(app, '/v1/bundles/v2:tailwind:abc', as('mallory'), { method: 'PUT', body: JSON.stringify({ js: 'evil()', css: '' }) })
    expect(put.status).toBe(204)
    expect((await call(app, '/v1/bundles/v2:tailwind:abc', as('alice'))).status).toBe(404)
    expect(await (await call(app, '/v1/bundles/v2:tailwind:abc', as('mallory'))).json()).toEqual({ js: 'evil()', css: '' })
    // and browser bundles are never public
    expect((await app.request('http://store.test/v1/b/crm/abc.js')).status).toBe(404)
  })
})

describe('quotas and plan as data (V1 A4, F14)', () => {
  it('token buckets through the store, for the agent only; plan overrides per app', async () => {
    const app = secureApp()
    const agent = { authorization: `Bearer ${APP_KEY}` }
    const op = { key: 'user:alice:edits', capacity: 1, refillPerSec: 0, op: 'take' }
    const take = () => call(app, '/v1/quota', agent, { method: 'POST', body: JSON.stringify({ ops: [op] }) })
    expect(await (await take()).json()).toMatchObject({ ok: true })
    expect(await (await take()).json()).toMatchObject({ ok: false, refused: 'user:alice:edits', retryAfterMs: null })
    expect((await call(app, '/v1/quota', { authorization: `Bearer ${await userToken('alice')}` }, { method: 'POST', body: JSON.stringify({ ops: [op] }) })).status).toBe(403)

    expect(await (await call(app, '/v1/plan', agent)).json()).toEqual({ plan: null, limits: {} })
    const admin = { authorization: `Bearer ${await userToken('root', { role: 'admin' })}` }
    expect((await call(app, '/v1/admin/plan', admin, { method: 'PUT', body: JSON.stringify({ limits: { userDailyUsd: 'lots' } }) })).status).toBe(400)
    await call(app, '/v1/admin/plan', admin, { method: 'PUT', body: JSON.stringify({ plan: 'team', limits: { userDailyUsd: 5 } }) })
    expect(await (await call(app, '/v1/plan', agent)).json()).toEqual({ plan: 'team', limits: { userDailyUsd: 5 } })
  })
})
