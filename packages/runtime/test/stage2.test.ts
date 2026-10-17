import fs from 'node:fs'
import { createRequire } from 'node:module'
import { compile } from 'tailwindcss'
import { describe, expect, it, vi } from 'vitest'
import { CssCompiler, extractCandidates } from '../src/css.js'
import { CommitRejectedError, MorphkitEngine } from '../src/engine.js'
import { MemoryStore } from '../src/store/memory.js'
import type { CssConfig, FileMap, SnapshotStore, TailwindModule } from '../src/types.js'
import { BASE, makeConfig, nodeCompiler, nodeLoader } from './helpers.js'

const CARD = 'src/dynamic/customer-card.tsx'
const require_ = createRequire(import.meta.url)
const twDir = require_.resolve('tailwindcss/package.json').replace(/package\.json$/, '')

function tailwindConfig(): CssConfig & { loads: () => number } {
  let loads = 0
  const mod: TailwindModule = {
    compile: compile as unknown as TailwindModule['compile'],
    input: [
      '@layer theme, base, components, utilities;',
      '@import "tailwindcss/theme.css" layer(theme);',
      '@import "tailwindcss/utilities.css" layer(utilities);',
      '@theme inline { --color-card: var(--card); }',
    ].join('\n'),
    stylesheets: {
      'tailwindcss/theme.css': fs.readFileSync(twDir + 'theme.css', 'utf8'),
      'tailwindcss/utilities.css': fs.readFileSync(twDir + 'utilities.css', 'utf8'),
    },
    extraSources: [`export const Card = () => <div className="rounded-xl p-5 pt-0" />`],
  }
  return {
    mode: 'tailwind',
    load: async () => {
      loads++
      return mod
    },
    loads: () => loads,
  }
}

function engineFor(store: SnapshotStore, opts: { css?: CssConfig; base?: FileMap; userId?: string } = {}) {
  const compiler = nodeCompiler()
  const config = makeConfig(opts.css ? { css: opts.css } : {}, opts.base)
  return new MorphkitEngine({ store, userId: opts.userId ?? 'alice', config, compiler, loader: nodeLoader })
}

describe('extractCandidates', () => {
  it('finds classes in JSX, cn() calls, template literals and arbitrary values', () => {
    const c = extractCandidates([
      `<dd className={cn('font-semibold', overdue && 'text-red-600')} />`,
      '<span className={`w-[123px] ${x}`}>',
      `<p className="grid grid-cols-[auto_1fr] hover:bg-blue-50 data-[state=open]:block">`,
    ])
    for (const cls of ['font-semibold', 'text-red-600', 'w-[123px]', 'grid-cols-[auto_1fr]', 'hover:bg-blue-50', 'data-[state=open]:block']) {
      expect(c).toContain(cls)
    }
  })
})

describe('CssCompiler (Tailwind 4 at runtime)', () => {
  it('generates exactly the utilities used, including arbitrary values, and is not additive across builds', async () => {
    const css = new CssCompiler(tailwindConfig())
    const first = await css.build({ [CARD]: `<b className="text-red-600 w-[123px] bg-card" />` })
    expect(first).toContain('.w-\\[123px\\]')
    expect(first).toContain('width: 123px')
    expect(first).toContain('--color-red-600')
    expect(first).toContain('background-color: var(--card)')
    // readonly sources are compiled too, so `pt-0` keeps winning over `p-5` in the cascade
    expect(first.indexOf('.p-5')).toBeLessThan(first.indexOf('.pt-0'))
    const second = await css.build({ [CARD]: `<b className="text-blue-700" />` })
    expect(second).toContain('.text-blue-700')
    expect(second).not.toContain('123px')
    expect(css.metrics.tailwindInitMs).not.toBeNull()
  })

  it('is a no-op in palette mode', async () => {
    const css = new CssCompiler({ mode: 'palette', load: null })
    expect(css.mode).toBe('palette')
    expect(await css.build({ [CARD]: `<b className="text-red-600" />` })).toBe('')
  })
})

describe('engine, Stage 2 additions', () => {
  it('puts Tailwind CSS for the edit into the committed bundle', async () => {
    const store = new MemoryStore()
    const engine = engineFor(store, { css: tailwindConfig() })
    await engine.init()
    engine.draft.start('red')
    engine.draft.write(CARD, `export default function C() { return <b className="text-red-600 w-[123px]">x</b> }`)
    await engine.draft.commit()
    const bundle = engine.currentBundle()
    expect(bundle?.css).toContain('.text-red-600')
    expect(bundle?.css).toContain('width: 123px')
    expect(engine.cssMode).toBe('tailwind')
  })

  it('warmup() initializes esbuild and the Tailwind compiler once', async () => {
    const css = tailwindConfig()
    const engine = engineFor(new MemoryStore(), { css })
    const m = await engine.warmup()
    await engine.warmup()
    expect(m.initMs).not.toBeNull()
    expect(m.tailwindInitMs).not.toBeNull()
    expect(css.loads()).toBe(1)
  })

  it('rejects a commit that drops the default export of a panel, before the head moves', async () => {
    const engine = engineFor(new MemoryStore())
    await engine.init()
    engine.draft.start('named only')
    engine.draft.write(CARD, `export function CustomerCard() { return null }`)
    const err = (await engine.draft.commit().catch((e: unknown) => e)) as CommitRejectedError
    expect(err).toBeInstanceOf(CommitRejectedError)
    expect(err.errors.map((e) => e.text)).toEqual([expect.stringContaining(`no default export in ${CARD}`)])
    expect(err.errors[0]!.rule).toBe('default-export')
    expect(engine.getState().head).toBeNull()
    expect(engine.getState().usingFallback).toBe(true)
  })

  it('also requires a default export from panels mounted at runtime (new files)', async () => {
    const engine = engineFor(new MemoryStore())
    await engine.init()
    const unmount = engine.mount('new-panel')
    engine.draft.start('new panel without default')
    engine.draft.write('src/dynamic/new-panel.tsx', `export const X = 1`)
    await expect(engine.draft.commit()).rejects.toThrow('no default export in src/dynamic/new-panel.tsx')
    unmount()
    expect(engine.requiredComponents()).not.toContain('src/dynamic/new-panel.tsx')
  })

  it('agentRequest() carries files, readonly, core types, compile context and required panels', async () => {
    const engine = engineFor(new MemoryStore())
    await engine.init()
    const req = engine.agentRequest('make it red', { target: 'customer-card' })
    expect(req.files).toEqual(BASE)
    expect(req.components).toEqual(['src/dynamic/customer-card.tsx', 'src/dynamic/dashboard-panels.tsx', 'src/dynamic/deals-table.tsx'])
    expect(req.context.dynamicRoots).toEqual(['src/dynamic/'])
    expect(req.target).toBe('customer-card')
  })

  it('marks a head made against an older release as stale; reset starts from the new base', async () => {
    const store = new MemoryStore()
    const v1 = engineFor(store)
    await v1.init()
    v1.draft.start('mine')
    v1.draft.write(CARD, `export default function C() { return <b>mine</b> }`)
    const mine = await v1.draft.commit()
    expect(mine.baseHash).toBe(await v1.currentBaseHash())
    expect(v1.getState().stale).toBe(false)

    // the app ships a new release that changed the card too, which alice had customized: she decides
    const newBase = { ...BASE, [CARD]: `export default function Card() { return <i>v2 card</i> }`, 'src/dynamic/deals-table.tsx': `export default function DealsTable() { return <i>v2</i> }` }
    const v2 = engineFor(store, { base: newBase })
    await v2.init()
    expect(v2.getState().stale).toBe(true)
    expect(v2.getState().stalePanels).toEqual(['customer-card'])
    expect(v2.getState().head?.id).toBe(mine.id)
    const migration = await v2.migrationInput()
    expect(migration?.oldBase).toEqual(BASE)
    expect(migration?.edited[CARD]).toContain('mine')

    const fresh = await v2.reset()
    expect(fresh?.author).toBe('base')
    expect(fresh?.files).toEqual(newBase)
    expect(v2.getState().stale).toBe(false)
    expect(v2.getState().usingFallback).toBe(true)
  })

  it('a commit on top of a stale head is made against the new base (agent migration)', async () => {
    const store = new MemoryStore()
    const v1 = engineFor(store)
    await v1.init()
    v1.draft.start('mine')
    v1.draft.write(CARD, `export default function C() { return <b>mine</b> }`)
    await v1.draft.commit()
    const v2 = engineFor(store, { base: { ...BASE, [CARD]: `export default () => 'v2 card'`, 'src/dynamic/deals-table.tsx': `export default () => null` } })
    await v2.init()
    expect(v2.getState().stale).toBe(true)
    v2.draft.start('migrated')
    v2.draft.write('src/dynamic/deals-table.tsx', `export default () => null`)
    const migrated = await v2.draft.commit('agent', { requestId: 'req-1' })
    expect(migrated.baseHash).toBe(await v2.currentBaseHash())
    expect(migrated.requestId).toBe('req-1')
    expect(v2.getState().stale).toBe(false)
  })

  it('refresh() picks up a head moved elsewhere (admin rollback on the server)', async () => {
    const store = new MemoryStore()
    const engine = engineFor(store)
    await engine.init()
    engine.draft.start('x')
    engine.draft.write(CARD, `export default function C() { return <b>x</b> }`)
    const s = await engine.draft.commit()
    await store.setHead('alice', s.parentId!)
    const listener = vi.fn()
    engine.subscribe(listener)
    await engine.refresh()
    expect(engine.getState().head?.id).toBe(s.parentId)
    expect(engine.getState().usingFallback).toBe(true)
    expect(listener).toHaveBeenCalled()
  })
})

describe('migration draft', () => {
  it('starts from the new base files while keeping the stale head as parent', async () => {
    const store = new MemoryStore()
    const v1 = engineFor(store)
    await v1.init()
    v1.draft.start('mine')
    v1.draft.write(CARD, `export default function C() { return <b>mine</b> }`)
    const mine = await v1.draft.commit()
    const newBase = { ...BASE, [CARD]: `export default function Card() { return <i>v2 card</i> }`, 'src/dynamic/deals-table.tsx': `export default function DealsTable() { return <i>v2</i> }` }
    const v2 = engineFor(store, { base: newBase })
    await v2.init()
    const draft = v2.draft.start('carry over', v2.originalFiles())
    expect(draft.parentId).toBe(mine.id)
    expect(draft.files).toEqual(newBase)
    v2.draft.write(CARD, `export default function C() { return <b>mine</b> }`)
    const migrated = await v2.draft.commit('agent')
    expect(migrated.files['src/dynamic/deals-table.tsx']).toContain('v2')
    expect(migrated.files[CARD]).toContain('mine')
    expect(v2.getState().stale).toBe(false)
  })
})
