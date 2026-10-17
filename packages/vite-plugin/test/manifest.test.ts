import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildManifest, findImports, globRoot } from '../src/manifest.js'
import { generateExternals, generateFallback } from '../src/index.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture')
const options = {
  zones: { dynamic: ['src/dynamic/**'], readonly: ['src/readonly/**', 'src/components/ui/**'] },
  externals: ['@/components/ui/*', '@/lib/utils', '@/readonly/*'],
}

describe('buildManifest', () => {
  const manifest = buildManifest(root, options)

  it('splits files into zones', () => {
    expect(manifest.dynamic.map((f) => f.path)).toEqual(['src/dynamic/card.tsx', 'src/dynamic/helpers.ts'])
    expect(manifest.readonly.map((f) => f.path)).toEqual([
      'src/components/ui/badge.tsx',
      'src/components/ui/button.tsx',
      'src/readonly/format.ts',
    ])
    expect(manifest.dynamic[0]!.source).toContain('export default function Card')
    expect(manifest.dynamicRoots).toEqual(['src/dynamic/'])
  })

  it('never ships core sources, only declarations of imported core files', () => {
    const all = JSON.stringify(manifest)
    expect(all).not.toContain('core entry')
    expect(manifest.coreTypes.map((f) => f.path)).toEqual(['src/lib/utils.d.ts'])
    const dts = manifest.coreTypes[0]!.source
    expect(dts).toContain('export declare function cn')
    expect(dts).not.toContain('core implementation detail')
  })

  it('expands externals with *', () => {
    expect(manifest.externals).toEqual([
      'react',
      'react-dom',
      'react/jsx-runtime',
      '@/components/ui/badge',
      '@/components/ui/button',
      '@/lib/utils',
      '@/readonly/format',
    ])
  })

  it('generates registry modules with absolute paths for aliased externals', () => {
    const ext = generateExternals(manifest, '/app')
    expect(ext).toContain('import * as e0 from "react"')
    expect(ext).toContain('from "/app/src/components/ui/button"')
    expect(ext).toContain('"@/components/ui/button": e4')
    const fb = generateFallback(manifest, '/app')
    expect(fb).toContain('import * as f0 from "/app/src/dynamic/card.tsx"')
    expect(fb).toContain('"src/dynamic/card.tsx": f0')
  })
})

describe('helpers', () => {
  it('globRoot', () => {
    expect(globRoot('src/dynamic/**')).toBe('src/dynamic/')
    expect(globRoot('src/dynamic/*.tsx')).toBe('src/dynamic/')
    expect(globRoot('**/*.tsx')).toBe('')
  })

  it('findImports', () => {
    const src = `import a from 'a'\nimport { b } from "b"\nimport './c.css'\nexport * from '@/d'\nconst e = import('e')\nimport type { F } from 'f'`
    expect(findImports(src)).toEqual(['a', 'b', './c.css', '@/d', 'e', 'f'])
  })
})
