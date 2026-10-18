import { afterEach, describe, expect, it, vi } from 'vitest'
import * as esbuild from 'esbuild-wasm'
import { Compiler, PLEATKIT_FRAME, type EsbuildApi } from '../src/compiler.js'
import { PleatkitEngine, type EngineOptions } from '../src/engine.js'
import { registryFor } from '../src/loader.js'
import { isEditFault } from '../src/react.js'
import { MemoryBootStorage, SAFE_MODE_MOUNT_MS } from '../src/safe-mode.js'
import { signBundle, signingKeyFromAppKey, sriDigest } from '../src/security.js'
import { bundleKey, BundleVerificationError, contextHash, ServerBundles } from '../src/server-bundles.js'
import { MemoryStore } from '../src/store/memory.js'
import type { CompiledBundle, FileMap, PleatkitConfig } from '../src/types.js'
import { hashFiles } from '../src/util.js'
import { BASE, makeConfig, manifest, nodeCompiler, nodeLoader } from './helpers.js'

const CARD = 'src/dynamic/customer-card.tsx'
const DEALS = 'src/dynamic/deals-table.tsx'
const nodeEsbuild = async () => esbuild as unknown as EsbuildApi

function engine(store: MemoryStore, extra: Omit<Partial<EngineOptions>, 'config'> & { base?: FileMap; config?: Partial<PleatkitConfig> } = {}) {
  const { base, config, ...rest } = extra
  return new PleatkitEngine({ store, userId: 'alice', config: makeConfig(config ?? {}, base), compiler: nodeCompiler(), loader: nodeLoader, bootStorage: null, ...rest })
}

async function commit(e: PleatkitEngine, path: string, source: string, message = 'edit') {
  e.draft.start(message)
  e.draft.write(path, source)
  return e.draft.commit()
}

afterEach(() => vi.useRealTimers())

describe('B5: per-file base hashes, carry-over after a release', () => {
  it('carries edits over by themselves when the release changed other files', async () => {
    const store = new MemoryStore()
    const v1 = engine(store)
    await v1.init()
    const mine = await commit(v1, CARD, `export default function C() { return <b>mine</b> }`)
    expect(Object.keys(mine.baseFiles ?? {})).toEqual(Object.keys(BASE))
    expect(mine.schemaVersion).toBe(2)

    const newBase = { ...BASE, [DEALS]: `export default function DealsTable() { return <i>v2</i> }` }
    const v2 = engine(store, { base: newBase })
    await v2.init()
    const s = v2.getState()
    expect(s.stale).toBe(false)
    expect(s.status).toBe('ready')
    expect(s.usingFallback).toBe(false)
    expect(s.head?.parentId).toBe(mine.id)
    expect(s.head?.message).toBe('Carried over to the new version of the app')
    expect(s.head?.files[CARD]).toContain('mine')
    expect(s.head?.files[DEALS]).toContain('v2')
    expect(s.head?.baseHash).toBe(await v2.currentBaseHash())
    // undo returns to the stale head
    expect((await v2.undo())?.id).toBe(mine.id)
  })

  it('stays stale, per panel, when the release changed a file the user changed too', async () => {
    const store = new MemoryStore()
    const v1 = engine(store)
    await v1.init()
    await commit(v1, CARD, `export default function C() { return <b>mine</b> }`)
    const v2 = engine(store, { base: { ...BASE, [CARD]: `export default () => 'v2'`, [DEALS]: `export default () => 'v2 deals'` } })
    await v2.init()
    expect(v2.getState()).toMatchObject({ stale: true, stalePanels: ['customer-card'] })
  })

  it('stays stale when the carried-over files do not compile on the new release', async () => {
    const store = new MemoryStore()
    const v1 = engine(store)
    await v1.init()
    const panels = 'src/dynamic/dashboard-panels.tsx'
    await commit(v1, panels, `import { Row } from './parts/row'\nexport default function D() { return <Row label="mine" /> }`)
    // the release removed the helper the user's version imports
    const newBase = { ...BASE }
    delete newBase['src/dynamic/parts/row.tsx']
    newBase[panels] = BASE[panels]!
    const v2 = engine(store, { base: newBase })
    await v2.init()
    expect(v2.getState()).toMatchObject({ stale: true, stalePanels: ['dashboard-panels'] })
  })
})

describe('B2: safe mode', () => {
  it('a version whose last load never mounted starts in safe mode, with the original modules', async () => {
    const boot = new MemoryBootStorage()
    const store = new MemoryStore()
    // the heartbeat never fires: as if the tab hung right after the swap
    const v1 = engine(store, { bootStorage: boot, heartbeatMs: 60_000 })
    await v1.init()
    const s = await commit(v1, CARD, `export default function C() { return <b>loops</b> }`)
    // the same page (another engine for the same user, e.g. after switching users) is not a failed load
    const samePage = engine(store, { bootStorage: boot })
    await samePage.init()
    expect(samePage.getState().safeMode).toBeNull()
    // the next page load is
    const again = engine(store, { bootStorage: boot, pageId: 'next-load' })
    await again.init()
    expect(again.getState().safeMode).toEqual({ reason: 'crash', snapshotId: s.id })
    expect(again.getState().usingFallback).toBe(true)
    expect(again.getState().head?.id).toBe(s.id)
    expect(again.tags()).toMatchObject({ 'pleatkit.snapshotId': 'base', 'pleatkit.safeMode': 'crash' })
    await again.leaveSafeMode()
    expect(again.getState()).toMatchObject({ safeMode: null, usingFallback: false })
  })

  it('a version that mounted, or a tab closed within 5 s, does not trigger it; ?pleatkit=safe does', async () => {
    const boot = new MemoryBootStorage()
    const store = new MemoryStore()
    const v1 = engine(store, { bootStorage: boot, heartbeatMs: 5 })
    await v1.init()
    const s = await commit(v1, CARD, `export default function C() { return <b>ok</b> }`)
    await new Promise((r) => setTimeout(r, 30))
    const key = [...boot.map.keys()][0]!
    expect(JSON.parse(boot.map.get(key)!)).toMatchObject({ snapshotId: s.id, mounted: true })
    const fine = engine(store, { bootStorage: boot })
    await fine.init()
    expect(fine.getState().safeMode).toBeNull()

    boot.map.set(key, JSON.stringify({ snapshotId: s.id, at: 1000, mounted: false, closedAt: 1000 + SAFE_MODE_MOUNT_MS - 1, page: 'old' }))
    const closedQuickly = engine(store, { bootStorage: boot })
    await closedQuickly.init()
    expect(closedQuickly.getState().safeMode).toBeNull()

    const forced = engine(store, { bootStorage: boot, safeMode: true })
    await forced.init()
    expect(forced.getState().safeMode?.reason).toBe('param')
  })
})

describe('B6: one registry per app instance, lazy externals', () => {
  it('two namespaces on one page do not share host modules; a lazy external loads only when an edit uses it', async () => {
    const icons = vi.fn(async () => ({ Star: () => 'star' }))
    const mk = (namespace: string) => {
      const config = makeConfig()
      config.externals = { ...config.externals, 'lucide-react': icons }
      config.manifest = { ...config.manifest, externals: [...config.manifest.externals, 'lucide-react'], externalPatterns: [...config.manifest.externalPatterns, 'lucide-react'] }
      const compiler = new Compiler({ ...config.manifest, namespace }, { loadEsbuild: nodeEsbuild })
      return new PleatkitEngine({ store: new MemoryStore(), userId: 'alice', config, compiler, loader: nodeLoader, bootStorage: null, namespace })
    }
    const a = mk('app-a')
    const b = mk('app-b')
    await Promise.all([a.init(), b.init()])
    expect(registryFor('app-a')).not.toBe(registryFor('app-b'))
    await commit(a, CARD, `export default function C() { return <b>plain</b> }`)
    expect(icons).not.toHaveBeenCalled()
    await commit(a, CARD, `import { Star } from 'lucide-react'\nexport default function C() { return <b><Star /></b> }`)
    expect(icons).toHaveBeenCalledTimes(1)
    expect(a.currentBundle()?.js).toContain('globalThis.__pleatkit.apps["app-a"].require("lucide-react")')
    expect(a.currentBundle()?.externals).toContain('lucide-react')
  })
})

describe('B7: bundles name their frames pleatkit://, tags for error reporting', () => {
  it('ends every bundle with a sourceURL; error boundaries can tell edit frames from app frames', async () => {
    const store = new MemoryStore()
    const e = engine(store)
    await e.init()
    const s = await commit(e, CARD, `export default function C() { return <b>x</b> }`)
    expect(e.currentBundle()?.js).toMatch(/\/\/# sourceURL=pleatkit:\/\/[0-9a-f]{16}\/bundle\.js\s*$/)
    expect(e.tags()).toMatchObject({ 'pleatkit.snapshotId': s.id, 'pleatkit.compile': 'browser', 'pleatkit.app': 'default' })
    expect(e.tags()['pleatkit.bundle']).toMatch(/^[0-9a-f]{40}$/)

    const fromEdit = new Error('boom')
    fromEdit.stack = 'Error: boom\n    at C (pleatkit://0123456789abcdef/bundle.js:3:9)\n    at renderWithHooks (react-dom.js:1:1)'
    const fromServerBundle = Object.assign(new Error('x'), { stack: 'Error: x\n    at C (http://app.test/pleatkit/b/crm/ab12.js:1:2)' })
    const fromApi = Object.assign(new Error('bad data'), { stack: 'Error: bad data\n    at formatDate (http://app.test/assets/index-abc.js:1:2)' })
    expect(isEditFault(fromEdit)).toBe(true)
    expect(isEditFault(fromServerBundle)).toBe(true)
    expect(isEditFault(fromApi)).toBe(false)
    expect(PLEATKIT_FRAME.test('blob:http://x/1')).toBe(false)
  })
})

/** Stands in for the agent server: compiles with the same compiler, keeps bundles by key. */
class FakeServer extends ServerBundles {
  bundles = new Map<string, CompiledBundle>()
  compiles = 0
  constructor(private readonly namespace: string) {
    super({ agentUrl: 'http://agent.test', bundleUrl: '/pleatkit/b', namespace, publicKey: null })
  }
  override async compile(body: Parameters<ServerBundles['compile']>[0]) {
    this.compiles++
    const r = await new Compiler({ ...manifest, namespace: this.namespace }, { loadEsbuild: nodeEsbuild }).compile(body.files)
    if (!r.ok || !r.bundle) return { ok: false, errors: r.errors, timeMs: 1 }
    const key = await bundleKey({ namespace: this.namespace, filesHash: r.hash, contextHash: await contextHash(body.manifest, body.readonly), cssMode: 'palette' })
    if (!body.check) this.bundles.set(key, r.bundle)
    return { ok: true, errors: [], key, timeMs: 1 }
  }
  override async load(key: string): Promise<CompiledBundle | null> {
    return this.bundles.get(key) ?? null
  }
}

describe('B1: compile on the server', () => {
  it('commits through the server, reuses a bundle the agent already compiled, and loads it on the next start', async () => {
    const store = new MemoryStore()
    const server = new FakeServer('default')
    const wasm = vi.fn()
    const compiler = { compile: wasm, metrics: { initMs: null, wasmBytes: null, wasmFromCache: null, esbuildVersion: null } }
    const mk = () => new PleatkitEngine({ store, userId: 'alice', config: makeConfig({ compile: 'server' }), compiler, loader: nodeLoader, bootStorage: null, serverBundles: server })
    const e = mk()
    await e.init()
    expect(e.compileMode).toBe('server')
    expect((await e.warmup()).initMs).toBeNull()
    const s = await commit(e, CARD, `export default function C() { return <b>server</b> }`)
    expect(server.compiles).toBe(1)
    expect(e.getState().usingFallback).toBe(false)

    // the agent result carries the bundle it compiled: no second compile
    const files = { ...e.files(), [CARD]: `export default function C() { return <b>again</b> }` }
    const pre = await server.compile({ userId: 'alice', files, readonly: {}, manifest, components: [] })
    e.draft.start('again')
    e.draft.write(CARD, files[CARD]!)
    await e.draft.commit('agent', { bundle: { key: pre.key!, filesHash: await hashFiles(files) } })
    expect(server.compiles).toBe(2)

    // check() goes to the server too; nothing compiles in the browser
    e.draft.start('broken')
    e.draft.write(CARD, `export default function C() { return <b>`)
    expect((await e.draft.check()).ok).toBe(false)
    e.draft.discard()
    expect(wasm).not.toHaveBeenCalled()

    const next = mk()
    await next.init()
    expect(next.getState().head?.parentId).toBe(s.id)
    expect(next.getState().usingFallback).toBe(false)
  })

  it('a configured public key forces server mode; a browser engine whose wasm cannot load falls back to the server', async () => {
    const pk = (await signingKeyFromAppKey('mk_live_0123456789abcdefghijklmnop')).publicKey
    expect(engine(new MemoryStore(), { config: { compile: 'browser', publicKey: pk } }).compileMode).toBe('server')

    const server = new FakeServer('default')
    const broken = { compile: vi.fn(async () => Promise.reject(new Error('WebAssembly.compile(): refused by CSP'))), metrics: { initMs: null, wasmBytes: null, wasmFromCache: null, esbuildVersion: null } }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const e = new PleatkitEngine({ store: new MemoryStore(), userId: 'alice', config: makeConfig({ compile: 'browser' }), compiler: broken, loader: nodeLoader, bootStorage: null, serverBundles: server })
    await e.init()
    await commit(e, CARD, `export default function C() { return <b>fallback</b> }`)
    expect(e.compileMode).toBe('server')
    expect(e.getState().compileMode).toBe('server')
    expect(server.compiles).toBe(1)
    expect(warn).toHaveBeenCalled()
  })
})

describe('B1/A3: the browser verifies signed bundles before they run', () => {
  const APP_KEY = 'mk_live_0123456789abcdefghijklmnop'
  async function serve(overrides: { app?: string; css?: string; signWith?: string; unsigned?: boolean } = {}) {
    const js = 'export const modules = {}'
    const css = '.a{color:red}'
    const key = 'ab'.repeat(20)
    const filesHash = 'f'.repeat(64)
    const payload = { v: 1 as const, app: overrides.app ?? 'crm', key, filesHash, js: await sriDigest(js), css: await sriDigest(css), externals: ['react'], compiler: 'x', createdAt: 'now' }
    const signature = overrides.unsigned ? { payload } : await signBundle(payload, await signingKeyFromAppKey(overrides.signWith ?? APP_KEY))
    const files: Record<string, string> = { [`/pleatkit/b/crm/${key}.json`]: JSON.stringify(signature), [`/pleatkit/b/crm/${key}.css`]: overrides.css ?? css }
    const fetchFn = (async (url: string) => (files[url] !== undefined ? new Response(files[url]) : new Response('no', { status: 404 }))) as unknown as typeof fetch
    const client = new ServerBundles({ agentUrl: '/agent', bundleUrl: '/pleatkit/b', namespace: 'crm', publicKey: (await signingKeyFromAppKey(APP_KEY)).publicKey, fetch: fetchFn })
    return { client, key, filesHash }
  }

  it('accepts a bundle signed by the app key and returns its URL with the SRI digest', async () => {
    const { client, key, filesHash } = await serve()
    const b = await client.load(key, filesHash)
    expect(b).toMatchObject({ url: `/pleatkit/b/crm/${key}.js`, css: '.a{color:red}', externals: ['react'] })
    expect(b?.integrity).toMatch(/^sha384-/)
    expect(await client.load('cd'.repeat(20), filesHash)).toBeNull()
  })

  it('refuses unsigned, foreign-key, other-app, other-files and tampered-CSS bundles', async () => {
    for (const [o, msg] of [
      [{ unsigned: true }, /unsigned or tampered/],
      [{ signWith: 'mk_live_zzzzzzzzzzzzzzzzzzzzzzzzzzzz' }, /unsigned or tampered/],
      [{ app: 'other' }, /made for app "other"/],
      [{ css: '.a{background:url(https://evil.test)}' }, /CSS does not match/],
    ] as const) {
      const { client, key, filesHash } = await serve(o)
      await expect(client.load(key, filesHash)).rejects.toThrow(msg)
    }
    const { client, key } = await serve()
    await expect(client.load(key, '0'.repeat(64))).rejects.toBeInstanceOf(BundleVerificationError)
  })
})

describe('F6: flags read by the runtime', () => {
  class FlaggedStore extends MemoryStore {
    constructor(private readonly f: Record<string, unknown>) {
      super()
    }
    async flags() {
      return this.f
    }
  }

  it('the kill switch shows the original version and refuses edits; edits.enabled=false keeps versions but refuses new ones', async () => {
    const store = new FlaggedStore({ 'pleatkit.enabled': true, 'edits.enabled': true })
    const e = engine(store)
    await e.init()
    await commit(e, CARD, `export default function C() { return <b>mine</b> }`)

    const killed = engine(new FlaggedStore({ 'pleatkit.enabled': false }) as MemoryStore)
    await killed.init()
    expect(killed.getState()).toMatchObject({ disabled: true, editsEnabled: false, usingFallback: true, status: 'ready' })

    const frozen = new FlaggedStore({ 'edits.enabled': false })
    // same snapshots and head as the first store
    Object.assign(frozen, { snapshots: (store as unknown as { snapshots: unknown }).snapshots, heads: (store as unknown as { heads: unknown }).heads })
    const f = engine(frozen)
    await f.init()
    expect(f.getState()).toMatchObject({ disabled: false, editsEnabled: false, usingFallback: false })
    f.draft.start('x')
    f.draft.write(CARD, `export default function C() { return <b>new</b> }`)
    await expect(f.draft.commit()).rejects.toThrow(/switched off/)
  })
})
