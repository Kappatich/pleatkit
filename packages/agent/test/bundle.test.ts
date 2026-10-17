import { describe, expect, it } from 'vitest'
import { bundleKey, contextHash, hashFiles, mintUserToken, publicKeyFromAppKey, verifyBundleSignature, type AgentResult, type BundleSignature } from '@morphkit/runtime/compiler'
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
    expect(js).toContain('globalThis.__morphkit.apps["test"].require("@/lib/utils")')
    expect(js).toMatch(/sourceURL=morphkit:\/\/[0-9a-f]{16}\/bundle\.js/)
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
