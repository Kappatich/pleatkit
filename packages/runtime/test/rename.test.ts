import 'fake-indexeddb/auto'
import { openDB } from 'idb'
import { describe, expect, it, vi } from 'vitest'
import * as compilerEntry from '../src/compiler-entry.js'
import { pleatkitEnv } from '../src/env.js'
import * as runtime from '../src/index.js'
import { MemoryBootStorage, migrateBootKey } from '../src/safe-mode.js'
import { legacyDbName, LocalStore } from '../src/store/local.js'
import { MemoryStore } from '../src/store/memory.js'
import type { Snapshot } from '../src/types.js'
import { makeConfig, nodeCompiler, nodeLoader } from './helpers.js'

// The rename morphkit → pleatkit (DECISIONS 68): one release of compatibility for every old name.

describe('PLEATKIT_* environment variables with the MORPHKIT_* fallback', () => {
  it('fills the new name from the old one and warns once, in one line', () => {
    const warn = vi.fn()
    const env: Record<string, string | undefined> = { MORPHKIT_APP_ID: 'crm', MORPHKIT_MODEL: 'm', OTHER: 'x' }
    expect(pleatkitEnv(env, warn)).toBe(env)
    expect(env).toMatchObject({ PLEATKIT_APP_ID: 'crm', PLEATKIT_MODEL: 'm', MORPHKIT_APP_ID: 'crm' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toMatch(/^\[pleatkit\] deprecated environment variables MORPHKIT_APP_ID, MORPHKIT_MODEL: rename to PLEATKIT_\*/)
    expect(warn.mock.calls[0]![0]).not.toContain('\n')
    pleatkitEnv(env, warn)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('the new name wins when both are set; no legacy names, no warning', () => {
    const warn = vi.fn()
    const both = pleatkitEnv({ PLEATKIT_APP_ID: 'new', MORPHKIT_APP_ID: 'old' }, warn)
    expect(both.PLEATKIT_APP_ID).toBe('new')
    expect(warn).toHaveBeenCalledTimes(1)
    const quiet = vi.fn()
    expect(pleatkitEnv({ PLEATKIT_APP_ID: 'new' }, quiet)).toEqual({ PLEATKIT_APP_ID: 'new' })
    expect(quiet).not.toHaveBeenCalled()
  })
})

describe('deprecated aliases from the public entry points', () => {
  it('each old name is the very same value as its new name', () => {
    expect(runtime.MorphkitEngine).toBe(runtime.PleatkitEngine)
    expect(runtime.MorphkitProvider).toBe(runtime.PleatkitProvider)
    expect(runtime.useMorphkit).toBe(runtime.usePleatkit)
    expect(runtime.useMorphkitState).toBe(runtime.usePleatkitState)
    expect(runtime.useMorphkitTags).toBe(runtime.usePleatkitTags)
    expect(runtime.MorphkitUiRoot).toBe(runtime.PleatkitUiRoot)
    expect(runtime.MORPHKIT_FRAME).toBe(runtime.PLEATKIT_FRAME)
    expect(compilerEntry.MORPHKIT_FRAME).toBe(compilerEntry.PLEATKIT_FRAME)
  })

  it('an engine made with the old class name works', async () => {
    const config: runtime.MorphkitConfig = makeConfig()
    const e: runtime.MorphkitEngine = new runtime.MorphkitEngine({ store: new MemoryStore(), userId: 'alice', config, compiler: nodeCompiler(), loader: nodeLoader })
    await e.init()
    expect(e).toBeInstanceOf(runtime.PleatkitEngine)
    expect(e.getState().status).toBe('ready')
  })

  it('stack frames of edits are recognised under the new scheme', () => {
    expect(runtime.PLEATKIT_FRAME.test('at x (pleatkit://abc/bundle.js:1:2)')).toBe(true)
    expect(runtime.PLEATKIT_FRAME.test('at x (/pleatkit/b/app/key.js:1:2)')).toBe(true)
  })
})

describe('browser storage keys move once', () => {
  it('the safe-mode boot record moves from morphkit:boot:… to pleatkit:boot:…', () => {
    const s = new MemoryBootStorage()
    s.set('morphkit:boot:app:alice', '{"snapshotId":"s1"}')
    migrateBootKey(s, 'morphkit:boot:app:alice', 'pleatkit:boot:app:alice')
    expect(s.get('pleatkit:boot:app:alice')).toBe('{"snapshotId":"s1"}')
    expect(s.get('morphkit:boot:app:alice')).toBeNull()
    // a record under the new key wins; the old one is still cleaned up
    s.set('morphkit:boot:app:alice', '{"snapshotId":"old"}')
    migrateBootKey(s, 'morphkit:boot:app:alice', 'pleatkit:boot:app:alice')
    expect(s.get('pleatkit:boot:app:alice')).toBe('{"snapshotId":"s1"}')
    expect(s.get('morphkit:boot:app:alice')).toBeNull()
    migrateBootKey(null, 'a', 'b')
  })

  it('the engine moves the boot record on start', () => {
    const boot = new MemoryBootStorage()
    boot.set('morphkit:boot:default:alice', JSON.stringify({ snapshotId: 'x', at: 1, mounted: true }))
    new runtime.PleatkitEngine({ store: new MemoryStore(), userId: 'alice', config: makeConfig(), compiler: nodeCompiler(), loader: nodeLoader, bootStorage: boot })
    expect([...boot.map.keys()]).toEqual(['pleatkit:boot:default:alice'])
  })

  it('legacy IndexedDB names', () => {
    expect(legacyDbName('pleatkit')).toBe('morphkit')
    expect(legacyDbName('pleatkit-demo-crm')).toBe('morphkit-demo-crm')
    expect(legacyDbName('t1-vite')).toBeNull()
    expect(legacyDbName('pleatkitty')).toBeNull()
  })

  it('a fresh LocalStore copies the pre-rename database once', async () => {
    const tag = Math.random().toString(36).slice(2)
    const snap: Snapshot = { id: 's1', parentId: null, userId: 'alice', files: { 'src/dynamic/a.tsx': 'x' }, message: 'm', author: 'base', createdAt: new Date().toISOString(), status: 'applied' }
    const old = await openDB(`morphkit-${tag}`, 1, {
      upgrade(db) {
        db.createObjectStore('snapshots', { keyPath: 'id' }).createIndex('byUser', 'userId')
        db.createObjectStore('heads', { keyPath: 'userId' })
        db.createObjectStore('bundles', { keyPath: 'hash' })
      },
    })
    await old.put('snapshots', snap)
    await old.put('heads', { userId: 'alice', id: 's1' })
    old.close()

    const store = new LocalStore(`pleatkit-${tag}`)
    expect(await store.head('alice')).toEqual(snap)
    // a second open of the existing database does not copy again
    await store.put({ ...snap, id: 's2', parentId: 's1' })
    await store.setHead('alice', 's2')
    const again = new LocalStore(`pleatkit-${tag}`)
    expect((await again.head('alice'))?.id).toBe('s2')
    // opting out
    const none = new LocalStore(`pleatkit-other-${tag}`, { migrateFrom: null })
    expect(await none.head('alice')).toBeNull()
  })
})

describe('the kill switch under its pre-rename key', () => {
  it('morphkit.enabled=false still switches pleatkit off', async () => {
    class Flagged extends MemoryStore {
      async flags() {
        return { 'morphkit.enabled': false }
      }
    }
    const e = new runtime.PleatkitEngine({ store: new Flagged(), userId: 'alice', config: makeConfig(), compiler: nodeCompiler(), loader: nodeLoader })
    await e.init()
    expect(e.getState()).toMatchObject({ disabled: true, editsEnabled: false })
  })
})
