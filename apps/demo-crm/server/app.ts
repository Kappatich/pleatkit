import { Hono } from 'hono'
import { seed, type Meta } from './data.js'

/** In-memory demo data API. `meta` is a free-form JSON object on every entity. */
export function createApp() {
  const db = seed()
  const app = new Hono().basePath('/api')

  app.get('/health', (c) => c.json({ ok: true }))
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
