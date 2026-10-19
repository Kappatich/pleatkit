import { describe, expect, it } from 'vitest'
import { createStoreApp, openStore } from '../src/index.js'

/** DECISIONS 75 Р5: the classifier's weekly record per app, for the agent's automatic parallel / sequential choice. */
function setup() {
  const store = openStore()
  const app = createStoreApp(store.db)
  const call = (p: string, headers: Record<string, string>, init: RequestInit = {}) => app.request(`http://store.test${p}`, { ...init, headers: { 'content-type': 'application/json', ...headers } })
  const agent = (appId: string) => ({ 'x-pleatkit-agent': '1', 'x-pleatkit-user': 'u1', 'x-pleatkit-app': appId })
  const raw = (store.db as unknown as { $client: { prepare(sql: string): { run(...p: unknown[]): unknown } } }).$client
  const log = async (appId: string, body: Record<string, unknown>, createdAtMs?: number) => {
    const res = await call('/v1/requests', agent(appId), { method: 'POST', body: JSON.stringify({ userId: 'u1', text: 'x', summary: '', log: [], ...body }) })
    const { id } = (await res.json()) as { id: string }
    if (createdAtMs !== undefined) raw.prepare('UPDATE requests SET created_at_ms = ? WHERE id = ?').run(createdAtMs, id)
    return id
  }
  return { call, agent, log }
}

const classified = { classifyMs: 900, modelMs: 0, toolsMs: 0, totalMs: 950 }
const edited = { classifyMs: 900, modelMs: 3000, toolsMs: 40, totalMs: 4000 }
const finish = [{ turn: 1, tool: 'finish', ok: true, ms: 1 }]

describe('GET /v1/classifier-stats', () => {
  it('counts requests the classifier ran on and the ones it answered alone, per hour, for this app only', async () => {
    const t = setup()
    const now = Date.now()
    // answered by the classifier alone: no tool log, a classifier verdict
    await t.log('crm', { verdict: 'needs-backend', classification: 'needs-backend', timings: classified })
    await t.log('crm', { verdict: 'clarify', classification: 'unclear', timings: classified })
    await t.log('crm', { verdict: 'refused', classification: 'off-topic', timings: classified })
    await t.log('crm', { verdict: 'declined', classification: 'off-topic', timings: classified })
    // the main model answered: an edit, and a needs-backend through its finish tool
    await t.log('crm', { verdict: 'ok', classification: 'ui', timings: edited, log: finish })
    await t.log('crm', { verdict: 'needs-backend', classification: 'needs-backend', timings: edited, log: finish })
    // the classifier did not run: a pointed-at panel, a quota refusal (classifyMs null) and an old row without timings
    await t.log('crm', { verdict: 'ok', target: 'card', timings: { ...edited, classifyMs: null }, log: finish })
    await t.log('crm', { verdict: 'refused', timings: { totalMs: 0, classifyMs: null, modelMs: 0, toolsMs: 0 } })
    await t.log('crm', { verdict: 'needs-backend' })
    // older than a week, and another app
    await t.log('crm', { verdict: 'needs-backend', classification: 'needs-backend', timings: classified }, now - 8 * 86_400_000)
    await t.log('other', { verdict: 'needs-backend', classification: 'needs-backend', timings: classified })

    const res = await t.call('/v1/classifier-stats?sinceMs=0', t.agent('crm'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sinceMs: number; bucketMs: number; buckets: { hourMs: number; classified: number; alone: number }[] }
    expect(body.bucketMs).toBe(3_600_000)
    // sinceMs is clamped to the last 7 days
    expect(body.sinceMs).toBeGreaterThanOrEqual(now - 7 * 86_400_000)
    const sum = body.buckets.reduce((s, b) => ({ classified: s.classified + b.classified, alone: s.alone + b.alone }), { classified: 0, alone: 0 })
    expect(sum).toEqual({ classified: 6, alone: 4 })
    for (const b of body.buckets) expect(b.hourMs % 3_600_000).toBe(0)

    const other = (await (await t.call('/v1/classifier-stats', t.agent('other'))).json()) as { buckets: { classified: number; alone: number }[] }
    expect(other.buckets).toEqual([expect.objectContaining({ classified: 1, alone: 1 })])
  })

  it('a later sinceMs leaves earlier rows out; a browser user may not read it', async () => {
    const t = setup()
    const now = Date.now()
    await t.log('crm', { verdict: 'needs-backend', classification: 'needs-backend', timings: classified }, now - 3 * 86_400_000)
    await t.log('crm', { verdict: 'ok', classification: 'ui', timings: edited, log: finish })
    const body = (await (await t.call(`/v1/classifier-stats?sinceMs=${now - 86_400_000}`, t.agent('crm'))).json()) as { buckets: { classified: number; alone: number }[] }
    expect(body.buckets).toEqual([expect.objectContaining({ classified: 1, alone: 0 })])
    expect((await t.call('/v1/classifier-stats', { 'x-pleatkit-user': 'u1', 'x-pleatkit-app': 'crm' })).status).toBe(403)
  })
})
