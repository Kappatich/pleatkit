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
    expect(js).toContain('globalThis.__pleatkit.apps["default"].require("react/jsx-runtime")')
    expect(js).toContain('globalThis.__pleatkit.apps["default"].require("@/lib/utils")')
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

describe('stage 5 block 5: CSS modules in the dynamic zone (found by a blind install)', () => {
  const compiler = nodeCompiler()
  it('a .module.css import is a class map with local names, and its rules are in the zone CSS', async () => {
    const files = {
      ...BASE,
      'src/dynamic/stats.tsx': `import styles from './stats.module.css'\nexport default function Stats() { return <div className={styles['grid']}><span className={styles.value}>1</span></div> }\n`,
      'src/dynamic/stats.module.css': `.grid { display: grid; grid-template-columns: repeat(3, 1fr); }\n.value { font-weight: 600; }\n`,
    }
    const r = await compiler.compile(files)
    expect(r.errors).toEqual([])
    const css = r.bundle!.css
    const local = /\.([\w-]*grid[\w-]*)\s*\{/.exec(css)?.[1]
    expect(local).toBeTruthy()
    // the map names the local class (the plain css loader made it `{}`)
    expect(r.bundle!.js).toContain(local!)
    expect(r.bundle!.js).not.toMatch(/var stats_default = \{\s*\}/)
    expect(css).toContain('@scope ([data-pleatkit-id])')
  })
})
