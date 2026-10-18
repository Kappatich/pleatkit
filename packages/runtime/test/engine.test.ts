import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { CommitRejectedError, PleatkitEngine, ZoneViolationError } from '../src/engine.js'
import { LocalStore } from '../src/store/local.js'
import { MemoryStore } from '../src/store/memory.js'
import type { SnapshotStore } from '../src/types.js'
import { BASE, makeConfig, nodeCompiler, nodeLoader } from './helpers.js'

const CARD = 'src/dynamic/customer-card.tsx'
const editedCard = (label: string) => `export default function CustomerCard() { return <b>${label}</b> }`
type Render = () => { props: { children: string } }

function engineFor(store: SnapshotStore, userId = 'alice') {
  const compiler = nodeCompiler()
  const spy = vi.spyOn(compiler, 'compile')
  const engine = new PleatkitEngine({ store, userId, config: makeConfig(), compiler, loader: nodeLoader })
  return { engine, spy }
}

const cardLabel = (engine: PleatkitEngine) => {
  const C = engine.getState().modules['customer-card']!.default as Render & { base?: string }
  return C.base ? 'BASE' : C().props.children
}

async function commitCard(engine: PleatkitEngine, label: string) {
  engine.draft.start(`set ${label}`)
  engine.draft.write(CARD, editedCard(label))
  return engine.draft.commit()
}

describe.each([
  ['MemoryStore', () => new MemoryStore()],
  ['LocalStore (IndexedDB)', () => new LocalStore(`test-${Math.random()}`)],
])('PleatkitEngine with %s', (_name, makeStore) => {
  it('starts on the fallback bundle when the user has no snapshots', async () => {
    const { engine, spy } = engineFor(makeStore())
    await engine.init()
    const s = engine.getState()
    expect(s.status).toBe('ready')
    expect(s.usingFallback).toBe(true)
    expect(Object.keys(s.modules).sort()).toEqual(['customer-card', 'dashboard-panels', 'deals-table', 'parts/row'])
    expect(cardLabel(engine)).toBe('BASE')
    expect(spy).not.toHaveBeenCalled()
  })

  it('commit swaps modules; undo/redo/reset walk the snapshot chain', async () => {
    const { engine } = engineFor(makeStore())
    await engine.init()
    const v1 = await commitCard(engine, 'v1')
    expect(cardLabel(engine)).toBe('v1')
    expect(engine.getState().canUndo).toBe(true)
    const v2 = await commitCard(engine, 'v2')
    expect(v2.parentId).toBe(v1.id)
    expect(cardLabel(engine)).toBe('v2')

    await engine.undo()
    expect(cardLabel(engine)).toBe('v1')
    expect(engine.getState().canRedo).toBe(true)
    await engine.undo()
    expect(cardLabel(engine)).toBe('BASE')
    expect(engine.getState().usingFallback).toBe(true)
    expect(await engine.undo()).toBeNull()

    await engine.redo()
    expect(cardLabel(engine)).toBe('v1')
    await engine.redo()
    expect(cardLabel(engine)).toBe('v2')
    expect(engine.getState().canRedo).toBe(false)

    await engine.reset()
    expect(cardLabel(engine)).toBe('BASE')
    await engine.redo()
    expect(cardLabel(engine)).toBe('v2')

    const history = await engine.history()
    expect(history.map((s) => s.author)).toEqual(['user', 'user', 'base'])
  })

  it('a new commit clears the redo stack', async () => {
    const { engine } = engineFor(makeStore())
    await engine.init()
    await commitCard(engine, 'v1')
    await engine.undo()
    await commitCard(engine, 'v3')
    expect(engine.getState().canRedo).toBe(false)
  })

  it('rejects a commit that does not compile and keeps the head', async () => {
    const { engine } = engineFor(makeStore())
    await engine.init()
    const v1 = await commitCard(engine, 'v1')
    engine.draft.start('broken')
    engine.draft.write(CARD, 'export default function () { return <div> }')
    const err = await engine.draft.commit().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CommitRejectedError)
    expect((err as CommitRejectedError).errors[0]).toMatchObject({ file: CARD, line: 1 })
    expect(engine.getState().head?.id).toBe(v1.id)
    expect(cardLabel(engine)).toBe('v1')
    expect(engine.getState().lastCheck?.ok).toBe(false)
    const rejected = (await engine.history()).find((s) => s.status === 'rejected')
    expect(rejected?.message).toBe('broken')
  })

  it('rejects a commit whose module throws while evaluating', async () => {
    const { engine } = engineFor(makeStore())
    await engine.init()
    engine.draft.start('throws at import')
    engine.draft.write(CARD, `throw new Error('top-level boom')\nexport default () => null`)
    const err = (await engine.draft.commit().catch((e: unknown) => e)) as CommitRejectedError
    expect(err.errors[0]!.text).toContain('top-level boom')
    expect(engine.getState().usingFallback).toBe(true)
  })

  it('refuses writes outside the dynamic zone', async () => {
    const { engine } = engineFor(makeStore())
    await engine.init()
    engine.draft.start('x')
    expect(() => engine.draft.write('src/lib/utils.ts', '')).toThrow(ZoneViolationError)
    expect(() => engine.draft.write('src/dynamic/../lib/utils.ts', '')).toThrow(ZoneViolationError)
    expect(() => engine.draft.write('src/dynamic/evil.sh', '')).toThrow(ZoneViolationError)
    expect(() => engine.draft.write('src/dynamic/new-panel.tsx', 'export default () => null')).not.toThrow()
  })

  it('keeps users isolated and restores a head from the bundle cache without recompiling', async () => {
    const store = makeStore()
    const alice = engineFor(store, 'alice')
    await alice.engine.init()
    await commitCard(alice.engine, 'alice-edit')

    const bob = engineFor(store, 'bob')
    await bob.engine.init()
    expect(cardLabel(bob.engine)).toBe('BASE')

    const alice2 = engineFor(store, 'alice')
    await alice2.engine.init()
    expect(cardLabel(alice2.engine)).toBe('alice-edit')
    expect(alice2.spy).not.toHaveBeenCalled()
  })

  it('rollback only undoes when the given snapshot is still the head', async () => {
    const { engine } = engineFor(makeStore())
    await engine.init()
    const v1 = await commitCard(engine, 'v1')
    const v2 = await commitCard(engine, 'v2')
    expect(await engine.rollback(v1.id)).toBeNull()
    await engine.rollback(v2.id)
    expect(engine.getState().head?.id).toBe(v1.id)
    expect(await engine.rollback(v2.id)).toBeNull()
    expect(engine.getState().canRedo).toBe(false)
  })
})

it('base files in the draft equal the manifest', async () => {
  const { engine } = engineFor(new MemoryStore())
  await engine.init()
  engine.draft.start()
  expect(engine.draft.files()).toEqual(BASE)
})
