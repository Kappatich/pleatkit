import { describe, expect, it } from 'vitest'
import { AuthError, createStoreApp, mintUserToken, openStore, type StoreExtension } from '../src/index.js'

const SECRET = 's'.repeat(40)
const APP_KEY = 'mk_live_0123456789abcdefghijklmnop'

function setup(options: Parameters<typeof createStoreApp>[1] = {}) {
  const store = openStore()
  const app = createStoreApp(store.db, options)
  const call = (path: string, headers: Record<string, string>, init: RequestInit = {}) =>
    app.request(`http://store.test${path}`, { ...init, headers: { 'content-type': 'application/json', ...headers } })
  return { app, call, db: store.db }
}

const admin = { 'x-pleatkit-admin': '1', 'x-pleatkit-app': 'crm' }

/**
 * DECISIONS 89: the open store knows the roles user and admin. Other roles, acting as a user, the report, the wish
 * map, release runs and code search are the pleatkit cloud's (`@pleatkit/store-cloud`, through `StoreExtension`).
 */
describe('DECISIONS 89: the open core and the cloud boundary', () => {
  it('a support token, the support role header and x-pleatkit-act-as get 403 cloud-feature', async () => {
    const t = setup({ auth: { apps: { crm: { appKey: APP_KEY, jwtSecret: SECRET } } } })
    const tok = async (role: string, userId = 'carol') => ({ authorization: `Bearer ${await mintUserToken({ secret: SECRET, userId, appId: 'crm', role })}` })
    const refused = async (res: Response) => {
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string; code: string }
      expect(body.code).toBe('cloud-feature')
      expect(body.error).toMatch(/pleatkit cloud feature/)
    }
    await refused(await t.call('/v1/admin/requests', await tok('support')))
    await refused(await t.call('/v1/heads/alice', await tok('support')))
    await refused(await t.call('/v1/heads/alice', { ...(await tok('admin', 'dave')), 'x-pleatkit-act-as': 'alice' }))
    await refused(await t.call('/v1/heads/alice', { ...(await tok('user', 'bob')), 'x-pleatkit-act-as': 'alice' }))
    // user and admin work as before
    expect((await t.call('/v1/heads/alice', await tok('user', 'alice'))).status).toBe(200)
    expect((await t.call('/v1/admin/requests', await tok('admin'))).status).toBe(200)

    const dev = setup()
    await refused(await dev.call('/v1/admin/requests', { 'x-pleatkit-role': 'support', 'x-pleatkit-user': 'carol', 'x-pleatkit-app': 'crm' }))
    await refused(await dev.call('/v1/heads/alice', { 'x-pleatkit-role': 'support', 'x-pleatkit-user': 'carol', 'x-pleatkit-app': 'crm', 'x-pleatkit-act-as': 'alice' }))
    await refused(await dev.call('/v1/heads/alice', { ...admin, 'x-pleatkit-act-as': 'alice' }))
    expect((await dev.call('/v1/heads/alice', { 'x-pleatkit-role': 'user', 'x-pleatkit-user': 'alice', 'x-pleatkit-app': 'crm' })).status).toBe(200)
  })

  it('the cloud routes are not in the open store: 404', async () => {
    const t = setup()
    for (const [method, path] of [
      ['GET', '/v1/report?from=2026-01-01&to=2026-01-02'],
      ['GET', '/v1/admin/wish-items'],
      ['GET', '/v1/admin/wishes'],
      ['PUT', '/v1/admin/wishes'],
      ['GET', '/v1/admin/snapshots?grep=evil'],
      ['POST', '/v1/admin/snapshots/rollback'],
      ['GET', '/v1/admin/releases'],
      ['PUT', '/v1/admin/releases/rel-0123456789'],
      ['POST', '/v1/admin/releases/rel-0123456789/rollback'],
    ] as const) {
      const res = await t.call(path, admin, { method, ...(method === 'GET' ? {} : { body: '{}' }) })
      expect(res.status, `${method} ${path}`).toBe(404)
    }
  })

  it('an extension can add a role, acting as a user, /admin access and middleware', async () => {
    const seen: string[] = []
    const ext: StoreExtension = {
      name: 'probe',
      roles: ['auditor'],
      actAs: (who, target) => {
        if (who.role !== 'admin') throw new AuthError(403, 'admins only', 'probe')
        return { ...who, userId: target, viewer: who.userId }
      },
      adminAccess: (who, method, path) => who.role === 'auditor' && method === 'GET' && path === '/admin/requests',
      middleware: (api, ctx) =>
        api.use('*', async (c, next) => {
          const who = c.get('caller')
          if (who.viewer) ctx.audited(who, 'probe.as', 'user', who.userId)
          seen.push(`${who.role}:${who.viewer ?? '-'}:${who.userId}`)
          await next()
        }),
    }
    const t = setup({ extensions: [ext] })
    const auditor = { 'x-pleatkit-role': 'auditor', 'x-pleatkit-user': 'ann', 'x-pleatkit-app': 'crm' }
    expect((await t.call('/v1/admin/requests', auditor)).status).toBe(200)
    expect((await t.call('/v1/admin/audit', auditor)).status).toBe(403)
    expect((await t.call('/v1/admin/requests', { ...auditor, 'x-pleatkit-role': 'support' })).status).toBe(403)
    const denied = await t.call('/v1/heads/alice', { ...auditor, 'x-pleatkit-act-as': 'alice' })
    expect(denied.status).toBe(403)
    expect(((await denied.json()) as { code: string }).code).toBe('probe')
    expect((await t.call('/v1/heads/alice', { 'x-pleatkit-role': 'admin', 'x-pleatkit-user': 'dave', 'x-pleatkit-app': 'crm', 'x-pleatkit-act-as': 'alice' })).status).toBe(200)
    expect(seen).toEqual(['auditor:-:ann', 'auditor:-:ann', 'admin:dave:alice'])
    const audit = (await (await t.call('/v1/admin/audit', admin)).json()) as { rows: { actor: string; action: string }[] }
    expect(audit.rows.find((r) => r.action === 'probe.as')?.actor).toBe('admin:dave:as:alice')
  })
})
