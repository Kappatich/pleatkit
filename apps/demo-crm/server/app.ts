import { Hono } from 'hono'
import { mintUserToken, publicKeyFromAppKey } from '@morphkit/store-server/token'
import { seed, type Meta } from './data.js'

/** In-memory demo data API. `meta` is a free-form JSON object on every entity. */
export function createApp() {
  const db = seed()
  const app = new Hono().basePath('/api')

  app.get('/health', (c) => c.json({ ok: true }))

  // The customer's backend mints short-lived user tokens for morphkit (V1 A1). A real backend takes the user
  // from its own session; this demo trusts the user switcher in the header. Off unless MORPHKIT_JWT_SECRET is set.
  app.get('/morphkit-token', async (c) => {
    const secret = process.env.MORPHKIT_JWT_SECRET
    if (!secret) return c.json({ error: 'no MORPHKIT_JWT_SECRET: the demo uses development headers' }, 404)
    const userId = c.req.query('user') ?? 'alice'
    const role = c.req.query('role') === 'admin' ? 'admin' : 'user'
    const token = await mintUserToken({ secret, userId: role === 'admin' ? `admin:${userId}` : userId, appId: c.req.query('app') ?? 'demo-crm', role, ttlSeconds: 900 })
    const appKey = process.env.MORPHKIT_APP_KEY
    return c.json({ token, publicKey: appKey ? await publicKeyFromAppKey(appKey) : null })
  })
  app.get('/customers', (c) => c.json(db.customers))
  app.get('/customers/:id', (c) => {
    const customer = db.customers.find((x) => x.id === c.req.param('id'))
    return customer ? c.json(customer) : c.json({ error: 'not found' }, 404)
  })
  app.patch('/customers/:id/meta', async (c) => {
    const customer = db.customers.find((x) => x.id === c.req.param('id'))
    if (!customer) return c.json({ error: 'not found' }, 404)
    customer.meta = { ...customer.meta, ...(await c.req.json<Meta>()) }
    return c.json(customer)
  })
  app.get('/deals', (c) => {
    const customerId = c.req.query('customerId')
    return c.json(customerId ? db.deals.filter((d) => d.customerId === customerId) : db.deals)
  })
  app.patch('/deals/:id/meta', async (c) => {
    const deal = db.deals.find((x) => x.id === c.req.param('id'))
    if (!deal) return c.json({ error: 'not found' }, 404)
    deal.meta = { ...deal.meta, ...(await c.req.json<Meta>()) }
    return c.json(deal)
  })
  return app
}
