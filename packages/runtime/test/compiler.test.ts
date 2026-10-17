import { describe, expect, it } from 'vitest'
import { installExternals } from '../src/loader.js'
import { BASE, makeConfig, nodeCompiler, nodeLoader } from './helpers.js'

describe('Compiler (esbuild-wasm, Node build)', () => {
  const compiler = nodeCompiler()

  it('bundles the whole dynamic zone with host modules as externals', async () => {
    const r = await compiler.compile(BASE)
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    const js = r.bundle!.js
    expect(js).toContain('globalThis.__morphkit.require("react/jsx-runtime")')
    expect(js).toContain('globalThis.__morphkit.require("@/lib/utils")')
    expect(js).not.toContain('function useState') // React itself is not bundled
    console.log(`[metrics] node esbuild-wasm: init ${compiler.metrics.initMs?.toFixed(0)} ms, compile of ${Object.keys(BASE).length} files ${r.timeMs.toFixed(1)} ms`)
  })

  it('produces modules that render through the host React', async () => {
    installExternals(makeConfig().externals)
    const r = await compiler.compile(BASE)
    const modules = await nodeLoader(r.bundle!)
    expect(Object.keys(modules).sort()).toEqual([
      'src/dynamic/customer-card.tsx',
      'src/dynamic/dashboard-panels.tsx',
      'src/dynamic/deals-table.tsx',
      'src/dynamic/parts/row.tsx',
    ])
    const Card = modules['src/dynamic/customer-card.tsx']!.default as (p: { name: string }) => { props: { className: string } }
    expect(Card({ name: 'Ada' }).props.className).toBe('card')
  })

  it('returns structured syntax errors with file, line and 1-based column', async () => {
    const r = await compiler.compile({ ...BASE, 'src/dynamic/deals-table.tsx': 'export default function X() {\n  return <div>\n}' })
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toMatchObject({ file: 'src/dynamic/deals-table.tsx', line: 3 })
    expect(r.errors[0]!.column).toBeGreaterThan(0)
    expect(r.errors[0]!.text).toMatch(/not valid|expected/i)
  })

  it('reports imports that are neither dynamic files nor externals', async () => {
    const r = await compiler.compile({ ...BASE, 'src/dynamic/customer-card.tsx': `import _ from 'lodash'\nimport { x } from '@/core/secret'\nexport default () => _(x)` })
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.text).join('\n')).toMatch(/"lodash" is not available/)
    expect(r.errors.map((e) => e.text).join('\n')).toMatch(/Cannot resolve "@\/core\/secret"/)
    expect(r.errors[0]).toMatchObject({ file: 'src/dynamic/customer-card.tsx', line: 1 })
  })

  it('times a check of the three dynamic panels (warm)', async () => {
    const times: number[] = []
    for (let i = 0; i < 5; i++) times.push((await compiler.compile({ ...BASE, 'src/dynamic/x.ts': `export const i = ${i}` })).timeMs)
    console.log(`[metrics] node warm check x5: ${times.map((t) => t.toFixed(1)).join(', ')} ms`)
    expect(Math.min(...times)).toBeLessThan(2000)
  })
})
