import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createStoreApp, openStore } from '../../store-server/src/index.js'
import { loadAgentExtensions } from '../src/extensions-loader.js'
import type { AgentExtension } from '../src/extension.js'
import { AnthropicProvider } from '../src/providers/anthropic.js'
import { RecordingProvider, ReplayProvider } from '../src/providers/recording.js'
import { ScriptedProvider, loadFixtures } from '../src/providers/scripted.js'
import { createAgentApp } from '../src/server.js'
import type { JsonCall } from '../src/types.js'

const CALL: JsonCall = {
  name: 'colors',
  instructions: 'Name the colors in the message.',
  message: 'red and blue',
  schema: { type: 'object', properties: { colors: { type: 'array', items: { type: 'string' } } }, required: ['colors'], additionalProperties: false },
  maxTokens: 256,
  // the scripted answer reads an extra key of the fixture files
  scripted: (fixtures) => ({ colors: fixtures.flatMap((f) => (Array.isArray(f.colors) ? (f.colors as string[]) : [])) }),
}

function fixturesDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-json-'))
  fs.writeFileSync(path.join(dir, 'colors.json'), JSON.stringify({ name: 'colors', match: [], turns: [], colors: ['red', 'blue'] }))
  return dir
}

describe('DECISIONS 89: one structured JSON call for extensions (completeJson)', () => {
  it('scripted: answered by the call’s own function over the fixture files (extra keys kept)', async () => {
    const dir = fixturesDir()
    expect(loadFixtures(dir)[0]).toMatchObject({ colors: ['red', 'blue'] })
    const out = await new ScriptedProvider(dir).completeJson(CALL)
    expect(JSON.parse(out.text)).toEqual({ colors: ['red', 'blue'] })
    expect(out.model).toBe('scripted-classifier')
    expect(JSON.parse((await new ScriptedProvider(dir).completeJson({ ...CALL, scripted: undefined })).text)).toBeNull()
  })

  it('Anthropic: the classifier model, structured output with the call’s schema and instructions', async () => {
    const calls: Record<string, unknown>[] = []
    const fetch = (async (_u: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(
        JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: '{"colors":["red"]}' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 30, output_tokens: 5 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof globalThis.fetch
    const provider = new AnthropicProvider({ apiKey: 'test', baseURL: 'http://anthropic.test', fetch })
    expect(provider.classifierModel).toBe('claude-haiku-5-5')
    const out = await provider.completeJson(CALL, AbortSignal.timeout(5000))
    expect(calls[0]).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 256, system: CALL.instructions, output_config: { effort: 'low', format: { type: 'json_schema', schema: CALL.schema } } })
    expect(calls[0]!.messages).toEqual([{ role: 'user', content: 'red and blue' }])
    expect(out).toMatchObject({ text: '{"colors":["red"]}', model: 'claude-haiku-5-5' })
  })

  it('a JSON call is recorded in a transcript of its own and replayed offline', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-json-rec-'))
    const rec = new RecordingProvider(new ScriptedProvider(fixturesDir()), { dir })
    const live = await rec.completeJson(CALL, AbortSignal.timeout(5000))
    const lines = fs
      .readFileSync(rec.files[0]!, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { kind: string; name?: string; call?: Record<string, unknown> })
    expect(lines.map((l) => l.kind)).toEqual(['meta', 'json'])
    expect(lines[1]).toMatchObject({ name: 'colors', call: { instructions: CALL.instructions, message: CALL.message, maxTokens: 256 } })
    expect(lines[1]!.call).not.toHaveProperty('scripted')
    expect(await new ReplayProvider(rec.files[0]!).completeJson(CALL)).toEqual(live)
  })
})

describe('DECISIONS 89: agent server extensions', () => {
  const provider = new ScriptedProvider([])

  it('the open server has no cloud routes: POST /agent/v1/wishes is 404', async () => {
    const app = createAgentApp({ provider, log: () => undefined, quotas: false, alerts: false })
    expect((await app.request('/agent/v1/wishes', { method: 'POST', headers: { 'x-pleatkit-admin': '1' }, body: '{}' })).status).toBe(404)
  })

  it('an extension adds routes under the base path with the server’s provider, admin rule and usage ledger', async () => {
    const { db } = openStore()
    const store = createStoreApp(db)
    const fetchVia = ((input: string | URL | Request, init?: RequestInit) => store.request(input instanceof Request ? input : String(input), init)) as typeof fetch
    const seen: string[] = []
    const probe: AgentExtension = {
      name: 'probe',
      routes(app, ctx) {
        app.post('/v1/probe', async (c) => {
          const appId = await ctx.adminApp(c, (await c.req.json().catch(() => ({}))) as { appId?: unknown })
          if (appId instanceof Response) return appId
          seen.push(`${ctx.provider?.name}:${ctx.storeUrl}:${ctx.appKey(appId)}:${(await ctx.manifest(appId)) === null}`)
          const stored = await ctx.reportUsage(appId, [{ type: 'cost.usd', value: 0.01, unit: 'usd', dedupeKey: 'probe:1' }])
          return c.json({ appId, stored })
        })
      },
    }
    const app = createAgentApp({ provider, log: () => undefined, quotas: false, alerts: false, storeUrl: 'http://store.test', fetch: fetchVia, extensions: [probe] })
    const post = (headers: Record<string, string>) => app.request('/agent/v1/probe', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ appId: 'crm' }) })
    expect((await post({})).status).toBe(403)
    const ok = await post({ 'x-pleatkit-admin': '1' })
    expect(await ok.json()).toEqual({ appId: 'crm', stored: 1 })
    expect(seen).toEqual(['scripted:http://store.test:null:true'])
    const events = (await (await store.request('http://store.test/v1/admin/events', { headers: { 'x-pleatkit-admin': '1', 'x-pleatkit-app': 'crm' } })).json()) as { type: string; source: string }[]
    expect(events).toEqual([expect.objectContaining({ type: 'cost.usd', source: 'agent' })])
  })

  it('the binary loads PLEATKIT_AGENT_EXTENSIONS, none, or @pleatkit/agent-cloud only when the deployment depends on it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-agent-ext-'))
    const deployment = (deps: Record<string, string>) => {
      const d = fs.mkdtempSync(path.join(dir, 'deploy-'))
      fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'deploy', private: true, dependencies: deps }))
      const ext = path.join(d, 'node_modules', 'probe-ext')
      fs.mkdirSync(ext, { recursive: true })
      fs.writeFileSync(path.join(ext, 'package.json'), JSON.stringify({ name: 'probe-ext', type: 'module', main: 'index.js' }))
      fs.writeFileSync(path.join(ext, 'index.js'), "export default (env) => [{ name: 'probe:' + (env.X ?? '') }, { name: 'second' }]\n")
      return d
    }
    const open = deployment({ '@pleatkit/agent': '0.4.0' })
    expect(await loadAgentExtensions({}, open)).toEqual({ extensions: [], modules: [] })
    expect(await loadAgentExtensions({ PLEATKIT_AGENT_EXTENSIONS: 'none' }, open)).toEqual({ extensions: [], modules: [] })
    const named = await loadAgentExtensions({ PLEATKIT_AGENT_EXTENSIONS: 'probe-ext', X: '1' }, open)
    expect(named.modules).toEqual(['probe-ext'])
    expect(named.extensions.map((e) => e.name)).toEqual(['probe:1', 'second'])
    await expect(loadAgentExtensions({ PLEATKIT_AGENT_EXTENSIONS: 'missing-ext' }, open)).rejects.toThrow(/PLEATKIT_AGENT_EXTENSIONS: cannot find "missing-ext"/)
    // declared but not installed: nothing (the package is private; an open deployment never has it)
    expect((await loadAgentExtensions({}, deployment({ '@pleatkit/agent-cloud': '0.4.0' }))).modules).toEqual([])
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
