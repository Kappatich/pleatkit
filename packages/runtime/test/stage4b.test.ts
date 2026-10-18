import { describe, expect, it } from 'vitest'
import { PleatkitEngine, MODULE_CACHE_SIZE, type EngineOptions } from '../src/engine.js'
import { HeadConflictError } from '../src/errors.js'
import { bundleKey, contextHash } from '../src/server-bundles.js'
import { HttpStore, HttpStoreError } from '../src/store/http.js'
import { MemoryStore } from '../src/store/memory.js'
import { sha256Bytes, sha384Bytes } from '../src/sha.js'
import { sriDigest, sha256Hex } from '../src/security.js'
import type { BundleLoader } from '../src/loader.js'
import type { FileMap, PleatkitConfig, Snapshot, SnapshotStore } from '../src/types.js'
import { hashFiles } from '../src/util.js'
import { BASE, makeConfig, manifest, nodeCompiler, nodeLoader } from './helpers.js'

const CARD = 'src/dynamic/customer-card.tsx'
const DEALS = 'src/dynamic/deals-table.tsx'

function engine(store: SnapshotStore, extra: Omit<Partial<EngineOptions>, 'config'> & { config?: Partial<PleatkitConfig>; base?: FileMap } = {}) {
  const { config, base, ...rest } = extra
  return new PleatkitEngine({ store, userId: 'alice', config: makeConfig(config ?? {}, base), compiler: nodeCompiler(), loader: nodeLoader, bootStorage: null, ...rest })
}

async function commit(e: PleatkitEngine, path: string, source: string, message = 'edit') {
  e.draft.start(message)
  e.draft.write(path, source)
  return e.draft.commit()
}

const card = (text: string) => `export default function C() { return <b>${text}</b> }`

/** A store whose head() and flags() never answer, or fail like a 500. */
function brokenStore(mode: 'hang' | 'fail'): SnapshotStore & { heal(): void } {
  const inner = new MemoryStore()
  let healed = false
  const broken = <T,>(ok: () => Promise<T>): Promise<T> =>
    healed ? ok() : mode === 'hang' ? new Promise<T>(() => undefined) : Promise.reject(new HttpStoreError(500, 'GET /heads/alice failed: 500'))
  return Object.assign(Object.create(inner) as MemoryStore, {
    head: (u: string) => broken(() => inner.head(u)),
    flags: () => broken(async () => ({})),
    heal: () => void (healed = true),
  })
}

describe('code review 06 §2 test 1: the store is down or hangs', () => {
  it.each(['hang', 'fail'] as const)('store %s: ready with the original version within the timeout, refresh() recovers', async (mode) => {
    const store = brokenStore(mode)
    const e = engine(store, { storeTimeoutMs: 200 })
    const started = Date.now()
    await e.init()
    expect(Date.now() - started).toBeLessThan(2_000)
    const s = e.getState()
    expect(s.status).toBe('ready')
    expect(s.usingFallback).toBe(true)
    expect(s.offline).toBe(true)
    expect(s.error).toMatch(/could not reach the pleatkit store/i)
    store.heal()
    await e.refresh()
    expect(e.getState()).toMatchObject({ offline: false, error: null, status: 'ready' })
  })

  it('HttpStore times out a request that never answers', async () => {
    const hanging: typeof fetch = (_url, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
    const store = new HttpStore({ baseUrl: '/s', userId: 'alice', fetch: hanging, timeoutMs: 100 })
    const started = Date.now()
    await expect(store.head('alice')).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('HttpStore refreshes an expired token once on 401 (brainstorm 05 #19)', async () => {
    const seen: string[] = []
    const f: typeof fetch = async (_url, init) => {
      const auth = new Headers(init?.headers).get('authorization') ?? ''
      seen.push(auth)
      return auth === 'Bearer fresh' ? new Response(JSON.stringify({ snapshot: null }), { status: 200 }) : new Response('expired', { status: 401 })
    }
    const store = new HttpStore({ baseUrl: '/s', userId: 'alice', fetch: f, token: (o) => (o?.refresh ? 'fresh' : 'old') })
    expect(await store.head('alice')).toBeNull()
    expect(seen).toEqual(['Bearer old', 'Bearer fresh'])
    const store2 = new HttpStore({ baseUrl: '/s', userId: 'alice', fetch: f, token: 'old', onAuthExpired: () => 'fresh' })
    expect(await store2.head('alice')).toBeNull()
  })
})

describe('code review 06 §2 test 2: two crashed panels of one edit undo it once', () => {
  it('rollback checks the head inside the queue', async () => {
    const e = engine(new MemoryStore())
    await e.init()
    const a = await commit(e, CARD, card('a'))
    const b = await commit(e, CARD, card('b'))
    const [r1, r2] = await Promise.all([e.rollback(b.id), e.rollback(b.id)])
    expect([r1?.id, r2?.id].filter(Boolean)).toEqual([a.id])
    expect(e.getState().head?.id).toBe(a.id)
    expect(e.getState().canRedo).toBe(false)
  })
})

describe('code review 06 §2 test 3: the head moves during an agent run (CAS)', () => {
  it('a commit made for an older head is refused and the head is reloaded', async () => {
    const store = new MemoryStore()
    const tab1 = engine(store)
    await tab1.init()
    const a = await commit(tab1, CARD, card('a'))
    const req = tab1.agentRequest('make it bold')
    expect(req.expectedHeadId).toBe(a.id)
    // another tab of the same user moves the head while the agent works
    const tab2 = engine(store)
    await tab2.init()
    const b = await commit(tab2, DEALS, `export default function D() { return <i>tab2</i> }`)
    tab1.draft.start('agent edit')
    tab1.draft.write(CARD, card('agent'))
    await expect(tab1.draft.commit('agent', { expectedHeadId: req.expectedHeadId })).rejects.toBeInstanceOf(HeadConflictError)
    await tab1.refresh()
    expect(tab1.getState().head?.id).toBe(b.id)
    expect(tab1.getState().draft).toBeNull()
  })

  it('refuses at once when this tab already knows the head moved', async () => {
    const e = engine(new MemoryStore())
    await e.init()
    const a = await commit(e, CARD, card('a'))
    const req = e.agentRequest('x')
    await commit(e, CARD, card('b'))
    e.draft.start('late')
    e.draft.write(CARD, card('late'))
    await expect(e.draft.commit('agent', { expectedHeadId: req.expectedHeadId })).rejects.toThrow(HeadConflictError)
    expect(req.expectedHeadId).toBe(a.id)
  })

  it('undo across tabs does not overwrite the other tab (returns null, reloads)', async () => {
    const store = new MemoryStore()
    const t1 = engine(store)
    await t1.init()
    await commit(t1, CARD, card('a'))
    const t2 = engine(store)
    await t2.init()
    const b = await commit(t2, CARD, card('b'))
    expect(await t1.undo()).toBeNull()
    await t1.refresh()
    expect(t1.getState().head?.id).toBe(b.id)
  })
})

describe('code review 06 §2 test 6: module cache and per-panel remounts', () => {
  it('50 commits keep at most MODULE_CACHE_SIZE evaluated bundles; undo/redo within the cache imports nothing', async () => {
    let loads = 0
    const counting: BundleLoader = (b) => {
      loads++
      return nodeLoader(b)
    }
    const e = engine(new MemoryStore(), { loader: counting })
    await e.init()
    const heapBefore = process.memoryUsage().heapUsed
    for (let i = 0; i < 50; i++) await commit(e, CARD, card(`v${i}`), `edit ${i}`)
    expect(loads).toBe(50)
    expect(e.moduleStats()).toMatchObject({ cached: MODULE_CACHE_SIZE, loads: 50 })
    for (let i = 0; i < 5; i++) await e.undo()
    for (let i = 0; i < 5; i++) await e.redo()
    expect(loads).toBe(50)
    expect(e.getState().head?.message).toBe('edit 49')
    // generous bound: 50 bundles of a few KB each must not grow the heap by tens of MB
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(80 * 1024 * 1024)
  }, 120_000)

  it('only the panel whose code changed gets a new version and module', async () => {
    const e = engine(new MemoryStore())
    await e.init()
    await commit(e, CARD, card('one'))
    const before = e.getState()
    await commit(e, CARD, card('two'))
    const after = e.getState()
    expect(after.panelVersions['customer-card']).not.toBe(before.panelVersions['customer-card'])
    expect(after.panelVersions['deals-table']).toBe(before.panelVersions['deals-table'])
    expect(after.modules['deals-table']).toBe(before.modules['deals-table'])
    expect(after.modules['customer-card']).not.toBe(before.modules['customer-card'])
  })
})

describe('code review 06 §2 test 7: a release that changes readonly, externals or the theme', () => {
  const variants: [string, Partial<PleatkitConfig['manifest']>][] = [
    ['readonly', { readonly: [{ path: 'src/readonly/api.ts', source: 'export const v = 2' }] }],
    ['externals', { externals: [...manifest.externals, 'lucide-react'] }],
    ['theme', { css: { mode: 'tailwind', input: '@theme { --color-brand: red; }', hash: 'theme-2' } }],
  ]
  it.each(variants)('%s: new bundle key, new release hash, edits carried over by themselves', async (_name, change) => {
    const store = new MemoryStore()
    const v1 = engine(store)
    await v1.init()
    const mine = await commit(v1, CARD, card('mine'))
    const config2 = makeConfig()
    config2.manifest = { ...config2.manifest, ...change }
    const v2 = new PleatkitEngine({ store, userId: 'alice', config: config2, compiler: nodeCompiler(), loader: nodeLoader, bootStorage: null })
    const filesHash = await hashFiles(mine.files)
    const ro = (m: PleatkitConfig['manifest']) => Object.fromEntries(m.readonly.map((f) => [f.path, f.source]))
    const k1 = await bundleKey({ namespace: 'default', filesHash, contextHash: await contextHash(manifest, ro(manifest)), cssMode: 'palette' })
    const k2 = await bundleKey({ namespace: 'default', filesHash, contextHash: await contextHash(config2.manifest, ro(config2.manifest)), cssMode: 'palette' })
    expect(k2).not.toBe(k1)
    expect(await v2.currentBaseHash()).not.toBe(await v1.currentBaseHash())
    await v2.init()
    const s = v2.getState()
    expect(s.stale).toBe(false)
    expect(s.head?.parentId).toBe(mine.id)
    expect(s.head?.message).toBe('Carried over to the new version of the app')
    expect(s.head?.baseHash).toBe(await v2.currentBaseHash())
  })
})

describe('code review 06 §2 test 10: insecure context (no crypto.subtle), Windows paths', () => {
  it('the JS digests match WebCrypto', async () => {
    const enc = new TextEncoder()
    for (const text of ['', 'abc', 'x'.repeat(1000), 'юникод ✓']) {
      const a = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))
      expect(sha256Bytes(enc.encode(text))).toEqual(a)
      const b = new Uint8Array(await crypto.subtle.digest('SHA-384', enc.encode(text)))
      expect(sha384Bytes(enc.encode(text))).toEqual(b)
    }
  })

  it('an engine loads, commits and hashes without crypto.subtle', async () => {
    const withSubtle = { hash: await hashFiles(BASE), sha: await sha256Hex('x'), sri: await sriDigest('x') }
    const desc = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle') ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.crypto), 'subtle')!
    Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true })
    try {
      expect(globalThis.crypto.subtle).toBeUndefined()
      expect({ hash: await hashFiles(BASE), sha: await sha256Hex('x'), sri: await sriDigest('x') }).toEqual(withSubtle)
      const e = engine(new MemoryStore())
      await e.init()
      const s = await commit(e, CARD, card('insecure'))
      expect(e.getState().head?.id).toBe(s.id)
    } finally {
      delete (globalThis.crypto as unknown as Record<string, unknown>).subtle
      if (!globalThis.crypto.subtle) Object.defineProperty(globalThis.crypto, 'subtle', desc)
    }
    expect(globalThis.crypto.subtle).toBeDefined()
  })

  it('refuses Windows-style paths in drafts', async () => {
    const e = engine(new MemoryStore())
    await e.init()
    e.draft.start('x')
    expect(() => e.draft.write('src\\dynamic\\customer-card.tsx', card('w'))).toThrow(/outside the dynamic zone/)
    expect(() => e.draft.write('src/dynamic/../core/x.tsx', card('w'))).toThrow(/outside the dynamic zone/)
  })
})

describe('brainstorm 05 #12 and #13: diagnostics, show the original, undo an edit from the middle', () => {
  it('diagnostics report the snapshot id and the modified panels', async () => {
    const e = engine(new MemoryStore())
    await e.init()
    expect(e.diagnostics()).toMatchObject({ snapshotId: null, modified: false, modifiedPanels: [] })
    const s = await commit(e, CARD, card('x'))
    const d = e.diagnostics()
    expect(d).toMatchObject({ snapshotId: s.id, shortId: s.id.slice(-8), modified: true, modifiedPanels: ['customer-card'], helpersModified: false, author: 'user' })
    await e.previewOriginal(true)
    expect(e.getState()).toMatchObject({ usingFallback: true, previewingOriginal: true })
    expect(e.getState().head?.id).toBe(s.id)
    await e.previewOriginal(false)
    expect(e.getState()).toMatchObject({ usingFallback: false, previewingOriginal: false })
  })

  it('takes back an edit from the middle of the chain when later edits did not touch its files', async () => {
    const e = engine(new MemoryStore())
    await e.init()
    const first = await commit(e, CARD, card('first'), 'card text')
    await commit(e, DEALS, `export default function D() { return <i>deals</i> }`, 'deals text')
    const plan = await e.revertPlan(first.id)
    expect(plan.files?.[CARD]).toBe(BASE[CARD])
    const s = (await e.revert(first.id)) as Snapshot
    expect(s.message).toBe('Undid: card text')
    expect(s.files[CARD]).toBe(BASE[CARD])
    expect(s.files[DEALS]).toContain('deals')
  })

  it('hands the diff to the agent when a later edit changed the same file', async () => {
    const e = engine(new MemoryStore())
    await e.init()
    const first = await commit(e, CARD, card('first'))
    await commit(e, CARD, card('second'))
    const plan = await e.revertPlan(first.id)
    expect(plan.files).toBeNull()
    expect(plan.revert).toMatchObject({ snapshotId: first.id, before: { [CARD]: BASE[CARD] }, after: { [CARD]: card('first') } })
    expect(await e.revert(first.id)).toBeNull()
    const req = e.agentRequest('undo that', { revert: plan.revert })
    expect(req.revert?.snapshotId).toBe(first.id)
  })
})
