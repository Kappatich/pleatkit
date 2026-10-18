import { describe, expect, it } from 'vitest'
import { createElement, version } from 'react'
import { renderToString } from 'react-dom/server'
import { Dynamic, MemoryStore, PleatkitEngine, PleatkitProvider, type PleatkitConfig } from '@pleatkit/runtime'

const CARD = 'src/dynamic/customer-card.tsx'

function config(): PleatkitConfig {
  const source = `export default function Card({ name }: { name: string }) { return <b>{name}</b> }`
  return {
    manifest: { version: 1, dynamicRoots: ['src/dynamic/'], dynamic: [{ path: CARD, source }], readonly: [], coreTypes: [], externals: ['react'], externalPatterns: ['react'], alias: {} },
    externals: {},
    fallback: { [CARD]: { default: ({ name }: { name: string }) => createElement('b', null, `card of ${name}`) } },
    wasmURL: null,
  }
}

describe('React 18 (peer range, V1 B6)', () => {
  it('renders the provider and a panel with React 18', async () => {
    expect(version.startsWith('18.')).toBe(true)
    const html = renderToString(
      createElement(PleatkitProvider, { config: config(), store: new MemoryStore(), userId: 'alice', safeModeBanner: false }, createElement(Dynamic, { id: 'customer-card', props: { name: 'Globex' }, loading: 'loading…' })),
    )
    // the first render waits for the user's head, as with React 19
    expect(html).toContain('loading…')
    expect(html).toContain('data-pleatkit-id="customer-card"')
  })

  it('the engine loads a user without edits and serves the original panel', async () => {
    const engine = new PleatkitEngine({ config: config(), store: new MemoryStore(), userId: 'alice', bootStorage: null })
    await engine.init()
    expect(engine.getState()).toMatchObject({ status: 'ready', usingFallback: true })
    const C = engine.getState().modules['customer-card']!.default as (p: { name: string }) => unknown
    expect(renderToString(createElement(C, { name: 'Globex' }))).toBe('<b>card of Globex</b>')
  })
})
