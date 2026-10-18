import { describe, expect, it } from 'vitest'
import { bundleKey, contextHash, hashFiles, mintUserToken, publicKeyFromAppKey, verifyBundleSignature, type AgentResult, type BundleSignature } from '@pleatkit/runtime/compiler'
import { createAgentApp } from '../src/server.js'
import { CARD, GOOD_CARD, request, scripted } from './helpers.js'

const APP_KEY = 'mk_live_0123456789abcdefghijklmnop'
const SECRET = 'k'.repeat(40)

const phone = scripted({
  name: 'phone',
  turns: [
    { calls: [{ tool: 'write_file', input: { path: CARD, content: GOOD_CARD } }, { tool: 'check', input: {} }] },
    { calls: [{ tool: 'finish', input: { verdict: 'ok', summary: 'Added.' } }] },
  ],
})

const TW_INPUT = ['@layer theme, base, components, utilities;', '@import "tailwindcss/theme.css" layer(theme);', '@import "tailwindcss/utilities.css" layer(utilities);'].join('\n')

function compileBody(extra: Record<string, unknown> = {}) {
  const r = request('x')
  return { appId: 'test', userId: 'alice', files: r.files, readonly: r.readonly, context: r.context, components: r.components, ...extra }
}
const post = (app: ReturnType<typeof createAgentApp>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(`/agent/v1/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

describe('server compile (V1 B1)', () => {
  it('compiles, keys and serves a bundle; the key is the one the browser computes', async () => {
    const app = createAgentApp({ provider: phone, log: () => undefined })
    const body = compileBody()
    const out = (await (await post(app, 'compile', body)).json()) as { ok: boolean; key: string; filesHash: string }
    expect(out.ok).toBe(true)
    expect(out.filesHash).toBe(await hashFiles(body.files))
    // what the runtime computes from its manifest
    expect(out.key).toBe(await bundleKey({ namespace: 'test', filesHash: out.filesHash, contextHash: await contextHash(body.context, body.readonly), cssMode: 'palette' }))

    const js = await (await app.request(`/agent/v1/b/test/${out.key}.js`)).text()
    expect(js).toContain('globalThis.__pleatkit.apps["test"].require("@/lib/utils")')
    expect(js).toMatch(/sourceURL=pleatkit:\/\/[0-9a-f]{16}\/bundle\.js/)
    expect(js).not.toContain('sourceMappingURL')
    const res = await app.request(`/agent/v1/b/test/${out.key}.json`)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const sig = (await res.json()) as BundleSignature
    expect(sig.payload).toMatchObject({ app: 'test', key: out.key, externals: ['@/lib/utils', 'react/jsx-runtime'] })
    expect(sig.sig).toBeUndefined() // no app key in development: unsigned
    expect((await app.request(`/agent/v1/b/test/${'0'.repeat(40)}.js`)).status).toBe(404)
  })

  it('refuses code that breaks the static rules or does not compile; check: true stores nothing', async () => {
    const app = createAgentApp({ provider: phone, log: () => undefined })
    const evil = compileBody({ files: { ...compileBody().files, [CARD]: `export default function C() { eval('1'); return null }` } })
    const bad = (await (await post(app, 'compile', evil)).json()) as { ok: boolean; errors: { rule?: string }[] }
    expect(bad.ok).toBe(false)
    expect(bad.errors.some((e) => e.rule === 'no-eval')).toBe(true)
    const checked = (await (await post(app, 'compile', compileBody({ check: true }))).json()) as { ok: boolean; key: string }
    expect(checked.ok).toBe(true)
    expect((await app.request(`/agent/v1/b/test/${checked.key}.js`)).status).toBe(404)
  })

  it('compiles the Tailwind utilities the files use, like the browser does', async () => {
    const app = createAgentApp({ provider: phone, log: () => undefined })
    const body = compileBody({ files: { ...compileBody().files, [CARD]: GOOD_CARD } })
    body.context = { ...body.context, css: { mode: 'tailwind', input: TW_INPUT, hash: 'h1' } }
    const out = (await (await post(app, 'compile', body)).json()) as { key: string }
    const css = await (await app.request(`/agent/v1/b/test/${out.key}.css`)).text()
    expect(css).toContain('.text-red-600')
  })

  it('with an app key the bundle is signed and the caller needs a user token', async () => {
    const app = createAgentApp({ provider: phone, log: () => undefined, auth: { credentials: { appId: 'test', appKey: APP_KEY, jwtSecret: SECRET }, production: true } })
    expect((await post(app, 'compile', compileBody())).status).toBe(401)
    const token = await mintUserToken({ secret: SECRET, userId: 'alice', appId: 'test' })
    const out = (await (await post(app, 'compile', compileBody(), { authorization: `Bearer ${token}` })).json()) as { key: string }
    const sig = (await (await app.request(`/agent/v1/b/test/${out.key}.json`)).json()) as BundleSignature
    await verifyBundleSignature(sig, await publicKeyFromAppKey(APP_KEY))
  })

  it('/run with compile: true returns the bundle of the resulting snapshot', async () => {
    const app = createAgentApp({ provider: phone, log: () => undefined })
    const res = await post(app, 'run', { ...request('phone'), compile: true })
    const chunk = (await res.text()).split('\n\n').find((c) => c.startsWith('event: result'))!
    const result = JSON.parse(/^data: (.*)$/m.exec(chunk)![1]!) as AgentResult
    expect(result.verdict).toBe('ok')
    const files = { ...request('phone').files, ...result.files }
    expect(result.bundle?.filesHash).toBe(await hashFiles(files))
    expect((await app.request(`/agent/v1/b/test/${result.bundle!.key}.js`)).status).toBe(200)
  })
})

describe('the bundle is in the store before "compiled" is answered (DECISIONS 70.8)', () => {
  /** A store-server stand-in whose bundle writes wait for `release()` and fail while `failing` is set. */
  function slowStore() {
    const stored = new Map<string, string>()
    const state = { puts: 0, failing: false, release: () => undefined as void }
    let gate = new Promise<void>((r) => (state.release = r))
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/v1/quota') return json({ ok: true, tokens: {} })
      if (url.pathname === '/v1/plan') return json({ plan: null, limits: {} })
      if (url.pathname === '/v1/flags') return json({ flags: {} })
      const put = /^\/v1\/bundles\/([0-9a-f]+)$/.exec(url.pathname)
      if (put && init?.method === 'PUT') {
        state.puts++
        await gate
        if (state.failing) return json({ error: 'disk full' }, 500)
        stored.set(put[1]!, String(init.body))
        return new Response(null, { status: 204 })
      }
      const get = /^\/v1\/b\/test\/([0-9a-f]+)\.json$/.exec(url.pathname)
      if (get) return stored.has(get[1]!) ? json(JSON.parse(stored.get(get[1]!)!).signature) : json({ error: 'not found' }, 404)
      return json({ error: `unexpected ${url.pathname}` }, 404)
    }) as typeof fetch
    return { f, stored, state, reopen: () => (gate = new Promise<void>((r) => (state.release = r))) }
  }

  it('a second compile of the same key waits for the first one’s store write', async () => {
    const s = slowStore()
    const app = createAgentApp({ provider: phone, log: () => undefined, storeUrl: 'http://store.test', fetch: s.f })
    const answered: string[] = []
    const first = Promise.resolve(post(app, 'compile', compileBody())).then(async (r) => (answered.push('first'), (await r.json()) as { ok: boolean; key: string }))
    const second = Promise.resolve(post(app, 'compile', compileBody())).then(async (r) => (answered.push('second'), (await r.json()) as { ok: boolean; key: string }))
    await new Promise((r) => setTimeout(r, 300))
    expect(answered).toEqual([]) // neither says "compiled" while the bundle is not in the store
    s.state.release()
    const [a, b] = await Promise.all([first, second])
    expect(a.key).toBe(b.key)
    expect(s.state.puts).toBe(1)
    expect(s.stored.has(a.key)).toBe(true)
  })

  it('a failed store write is not cached as compiled: the next compile writes again', async () => {
    const s = slowStore()
    s.state.failing = true
    s.state.release()
    const app = createAgentApp({ provider: phone, log: () => undefined, storeUrl: 'http://store.test', fetch: s.f })
    expect((await post(app, 'compile', compileBody())).status).toBe(500)
    s.state.failing = false
    const out = (await (await post(app, 'compile', compileBody())).json()) as { ok: boolean; key: string }
    expect(out.ok).toBe(true)
    expect(s.state.puts).toBe(2)
    expect(s.stored.has(out.key)).toBe(true)
  })
})
