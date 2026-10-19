/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect raw JSON wire payloads */
import * as esbuildWasm from 'esbuild-wasm'
import { describe, expect, it } from 'vitest'
import { Compiler, type EsbuildApi, type PleatkitManifest } from '@pleatkit/runtime/compiler'
import { runAgent, CUT_OFF } from '../src/loop.js'
import { configFromEnv } from '../src/config.js'
import { trustedInput } from '../src/manifest.js'
import { perCallMaxTokens } from '../src/providers/budget.js'
import { createAgentApp } from '../src/server.js'
import { capResult, MAX_TOOL_RESULT_CHARS } from '../src/tools.js'
import type { ModelProvider, ModelSession, TurnOptions } from '../src/types.js'
import { Workspace } from '../src/workspace.js'
import { BASE_CARD, CARD, GOOD_CARD, TABLE, request, scripted } from './helpers.js'

const post = (app: ReturnType<typeof createAgentApp>, body: unknown, path = '/agent/v1/run', headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

const manifest: PleatkitManifest = {
  version: 1,
  dynamicRoots: ['src/dynamic/'],
  dynamic: [
    { path: CARD, source: BASE_CARD },
    { path: TABLE, source: 'export default function DealsTable() { return <table /> }\n' },
  ],
  readonly: [{ path: 'src/readonly/api.ts', source: 'export interface Customer { id: string; name: string; meta: Record<string, unknown> }\n' }],
  coreTypes: [],
  externals: ['react', 'react/jsx-runtime', '@/lib/utils', '@/readonly/api'],
  externalPatterns: ['react', 'react/jsx-runtime', '@/lib/utils', '@/readonly/*'],
  alias: { '@': 'src' },
}

describe('code review 06 §2 test 4: the client context is not trusted', () => {
  it('with a server manifest, externalPatterns ["*"] from the browser change nothing', async () => {
    const lodash = `import _ from 'lodash'\nexport default function C() { return <b>{String(_)}</b> }`
    const provider = scripted({ name: 'sneaky', turns: [{ calls: [{ tool: 'write_file', input: { path: CARD, content: lodash } }, { tool: 'check', input: {} }] }, { calls: [{ tool: 'finish', input: { verdict: 'ok', summary: 'x' } }] }] })
    const app = createAgentApp({ provider, log: () => undefined, manifest })
    const body = request('sneaky', { context: { ...request('x').context, externals: ['*'], externalPatterns: ['*'] }, readonly: { 'src/readonly/api.ts': 'export const forged = 1' } })
    const text = await (await post(app, body)).text()
    const result = JSON.parse(/event: result\ndata: (.*)/.exec(text)![1]!)
    expect(result.verdict).toBe('failed')
    const check = result.log.find((l: any) => l.tool === 'check')
    expect(check.result).toMatch(/allowed-imports|not available/)
    // what the run used came from the manifest
    expect(trustedInput(manifest, 'test', body).readonly['src/readonly/api.ts']).toContain('interface Customer')
  })

  it('without a manifest, a context that switches the rules off is refused', async () => {
    const app = createAgentApp({ provider: scripted({ name: 'x', turns: [] }), log: () => undefined })
    const res = await post(app, request('x', { context: { ...request('x').context, externalPatterns: ['*'] } }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/would allow any import/)
    const res2 = await post(app, request('x', { context: { ...request('x').context, dynamicRoots: ['../core/'] } }))
    expect(res2.status).toBe(400)
  })

  it('DECISIONS 63.1: allowedHosts reaches check only from the server manifest, never from the body', async () => {
    const cdnCard = `export default function CustomerCard() { return <img src="https://cdn.example.com/logo.png" alt="" /> }\n`
    const run = async (opts: { manifest?: PleatkitManifest }, body: ReturnType<typeof request>) => {
      const provider = scripted({ name: 'cdn', turns: [{ calls: [{ tool: 'write_file', input: { path: CARD, content: cdnCard } }, { tool: 'check', input: {} }] }, { calls: [{ tool: 'finish', input: { verdict: 'ok', summary: 'x' } }] }] })
      const app = createAgentApp({ provider, log: () => undefined, ...opts })
      const text = await (await post(app, body)).text()
      return JSON.parse(/event: result\ndata: (.*)/.exec(text)![1]!)
    }
    const forged = request('cdn', { context: { ...request('x').context, allowedHosts: ['cdn.example.com'] } })
    // the body's list is dropped: without a manifest, and with a manifest that lists nothing
    expect(trustedInput(null, 'test', forged).context.allowedHosts).toBeUndefined()
    expect(trustedInput(manifest, 'test', forged).context.allowedHosts).toBeUndefined()
    expect((await run({}, forged)).verdict).toBe('failed')
    expect((await run({ manifest }, forged)).verdict).toBe('failed')
    // the manifest's list (normalized) is what check uses
    const withHosts: PleatkitManifest = { ...manifest, allowedHosts: ['CDN.example.com'] }
    expect(trustedInput(withHosts, 'test', request('x')).context.allowedHosts).toEqual(['cdn.example.com'])
    expect((await run({ manifest: withHosts }, request('cdn'))).verdict).toBe('ok')
    expect(() => trustedInput({ ...manifest, allowedHosts: ['*.example.com'] }, 'test', request('x'))).toThrow(/wildcard/)
  })

  it('production needs PLEATKIT_MANIFEST', () => {
    const creds = { NODE_ENV: 'production', PLEATKIT_APP_ID: 'crm', PLEATKIT_APP_KEY: `mk_live_${'a'.repeat(32)}`, PLEATKIT_JWT_SECRET: 's'.repeat(32) }
    expect(() => configFromEnv(creds)).toThrow(/PLEATKIT_MANIFEST/)
    expect(configFromEnv({ ...creds, PLEATKIT_MANIFEST: 'dist/pleatkit.manifest.json' }).manifest).not.toBeNull()
  })
})

describe('code review 06 §2 test 9: max_tokens with a partial tool_use', () => {
  it('the cut-off call is not run, the model is told, and the run can still finish', async () => {
    const provider = scripted({
      name: 'cut',
      turns: [
        // the reply hit max_tokens while writing the second file: only the first call is run
        { stop: 'max_tokens', calls: [{ tool: 'read_file', input: { path: CARD } }, { tool: 'write_file', input: { path: CARD, content: 'export default function C() { return <div' } }] },
        { calls: [{ tool: 'write_file', input: { path: CARD, content: GOOD_CARD } }, { tool: 'finish', input: { verdict: 'ok', summary: 'Done.' } }] },
      ],
    })
    const r = await runAgent(request('cut'), provider)
    expect(r.verdict).toBe('ok')
    expect(r.files[CARD]).toBe(GOOD_CARD)
    const cut = r.log.find((l) => l.result === CUT_OFF)!
    expect(cut).toMatchObject({ tool: 'write_file', ok: false, violation: 'output cut off (max_tokens)' })
    expect(r.log.filter((l) => l.tool === 'write_file' && l.ok)).toHaveLength(1)
  })

  it('the per-call ceiling follows the visible budget left', () => {
    expect(perCallMaxTokens(8000)).toBe(16_000)
    expect(perCallMaxTokens(1000)).toBe(9_000)
    expect(perCallMaxTokens(0)).toBe(8_000)
    expect(perCallMaxTokens(-50)).toBeGreaterThanOrEqual(1_024)
  })

  it('tool results are capped', () => {
    expect(capResult('x'.repeat(MAX_TOOL_RESULT_CHARS + 10))).toMatch(/\[cut: 10 more characters/)
    expect(capResult('short')).toBe('short')
  })
})

describe('code review 06 §2 test 8: SSE heartbeat and disconnect', () => {
  it('sends keepalive comments while the model is quiet', async () => {
    const provider = scripted({ name: 'slow', turns: [{ delayMs: 120, calls: [{ tool: 'finish', input: { verdict: 'failed', summary: 'x' } }] }] })
    const app = createAgentApp({ provider, log: () => undefined, heartbeatMs: 20 })
    const text = await (await post(app, request('slow'))).text()
    expect(text).toMatch(/^: keepalive$/m)
    expect(text).toMatch(/event: result/)
  })

  it('a client that disconnects aborts the model call', async () => {
    let seen: AbortSignal | null = null
    const hanging: ModelProvider = {
      name: 'hanging',
      model: 'hanging',
      classify: async () => ({ label: 'ui', reason: '', usage: null, model: null }),
      start: (): ModelSession => ({
        say: () => undefined,
        next: (_r, o: TurnOptions) => {
          seen = o.signal
          return new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(o.signal.reason as Error)))
        },
      }),
    }
    const app = createAgentApp({ provider: hanging, log: () => undefined })
    const res = await post(app, request('anything', { target: 'customer-card' }))
    const reader = res.body!.getReader()
    await reader.read()
    for (let i = 0; i < 50 && !seen; i++) await new Promise((r) => setTimeout(r, 10))
    await reader.cancel()
    for (let i = 0; i < 50 && !(seen as AbortSignal | null)?.aborted; i++) await new Promise((r) => setTimeout(r, 10))
    expect((seen as AbortSignal | null)?.aborted).toBe(true)
  })

  it('refuses a body above the limit with 413', async () => {
    const app = createAgentApp({ provider: scripted({ name: 'x', turns: [] }), log: () => undefined, bodyLimitBytes: 5_000 })
    const res = await post(app, request('x', { files: { [CARD]: 'x'.repeat(10_000) } }))
    expect(res.status).toBe(413)
  })
})

describe('code review 06 §2 test 10: browser and server check agree', () => {
  const browser = new Compiler(request('x').context, { loadEsbuild: async () => esbuildWasm as unknown as EsbuildApi })
  const corpus: Record<string, string> = {
    'export default 42': 'export default 42',
    'plain object': 'export default {}',
    'named only': 'export function C() { return null }',
    good: 'export default function C() { return <b>ok</b> }',
    fetch: "export default function C() { fetch('https://evil.example'); return null }",
    storage: "export default function C() { localStorage.setItem('a', 'b'); return null }",
    'img src': 'export default function C({ u }: { u: string }) { return <img src={u} /> }',
    syntax: 'export default function C() { return <div><span></div> }',
  }
  it.each(Object.entries(corpus))('%s', async (_name, source) => {
    const files = { ...request('x').files, [CARD]: source }
    const server = new Workspace({ ...request('x'), files })
    const s = await server.check()
    const b = await browser.compile(files, { components: request('x').components })
    expect(b.ok).toBe(s.ok)
    const key = (e: { rule?: string; file: string }) => `${e.file}:${e.rule ?? 'compile'}`
    expect(b.errors.map(key).sort()).toEqual(s.errors.map(key).sort())
  })
})
