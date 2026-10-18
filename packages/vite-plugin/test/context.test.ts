import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildAgentContext, moduleRefs } from '../src/context.js'
import type { ManifestFile } from '../src/manifest.js'

// a small app: the panel imports one name through a barrel and a helper; the barrel forwards two modules
const dynamic: ManifestFile[] = [
  { path: 'src/dynamic/panel.tsx', source: `import { Pager } from '@/components/table'\nimport { cn } from '@/lib/utils'\nimport { format } from './helpers'\nexport default function P() { return null }\n` },
  { path: 'src/dynamic/helpers.ts', source: `export const format = (x: number) => String(x)\n` },
]
const readonly: ManifestFile[] = [
  { path: 'src/components/table/index.ts', source: `export { Pager } from './pager'\nexport { BulkBar } from './bulk-bar'\n` },
  { path: 'src/components/table/pager.tsx', source: `import { cn } from '@/lib/utils'\nimport type { PageInfo } from '@/lib/types'\nexport function Pager(p: { info: PageInfo }) { return cn('x') }\n` },
  { path: 'src/components/table/bulk-bar.tsx', source: `export function BulkBar() { return 'a long helper nobody uses' }\n` },
  { path: 'src/lib/utils.ts', source: `export function cn(...c: string[]): string { return c.join(' ') }\n` },
]
const coreTypes: ManifestFile[] = [{ path: 'src/lib/types.d.ts', source: `export interface PageInfo { page: number; size: number }\n` }]
// what TypeScript's declaration emit gives for the readonly files (runtime imports such as cn are gone)
const dts: Record<string, string> = {
  'src/components/table/index.d.ts': `export { Pager } from './pager';\nexport { BulkBar } from './bulk-bar';\n`,
  'src/components/table/pager.d.ts': `import type { PageInfo } from '@/lib/types';\nexport declare function Pager(p: { info: PageInfo }): string;\n`,
  'src/components/table/bulk-bar.d.ts': `export declare function BulkBar(): string;\n`,
  'src/lib/utils.d.ts': `export declare function cn(...c: string[]): string;\n`,
}
const known = new Set([...readonly.map((f) => f.path), 'src/lib/types.ts', ...dynamic.map((f) => f.path)])
const resolve = (spec: string, importer: string): string | null => {
  const base = spec.startsWith('@/') ? 'src/' + spec.slice(2) : spec.startsWith('.') ? path.posix.join(path.posix.dirname(importer), spec) : null
  if (!base) return null
  return ['', '.ts', '.tsx', '/index.ts'].map((e) => base + e).find((p) => known.has(p)) ?? null
}
const input = {
  root: '/app',
  alias: { '@': 'src' },
  dynamic,
  readonly,
  coreTypes,
  resolve,
  isDynamic: (f: string) => f.startsWith('src/dynamic/'),
  declarations: (files: string[]) => files.map((f) => ({ path: f.replace(/\.tsx?$/, '.d.ts'), source: dts[f.replace(/\.tsx?$/, '.d.ts')] ?? '' })),
}

describe('DECISIONS 74.6: the agent context holds only what the panels reach, as declarations', () => {
  it('follows imported names through barrels and the types the declarations use; leaves the rest out', () => {
    const c = buildAgentContext(input)
    expect(c.files.map((f) => f.path)).toEqual(['src/components/table/index.d.ts', 'src/components/table/pager.d.ts', 'src/lib/types.d.ts', 'src/lib/utils.d.ts'])
    // declarations, not sources
    expect(c.files.find((f) => f.path.endsWith('pager.d.ts'))!.source).toContain('export declare function Pager')
    expect(c.omitted).toEqual([])
    expect(c.estimatedTokens).toBeLessThan(c.untrimmedTokens)
  })

  it('the cap leaves the farthest modules out first and names them', () => {
    const c = buildAgentContext({ ...input, capTokens: 60 })
    expect(c.omitted).toContain('src/lib/types.d.ts')
    expect(c.files.map((f) => f.path)).not.toContain('src/lib/types.d.ts')
    expect(c.estimatedTokens).toBeLessThanOrEqual(60)
  })

  it('reads imports, re-exports and own exports of a module', () => {
    const r = moduleRefs('x.ts', `import D, { a as b, type T } from './m'\nimport * as NS from './n'\nexport { c } from './c'\nexport * from './all'\nexport const own = 1\nexport interface I {}\n`)
    expect(r.imports).toEqual([
      { spec: './m', names: new Set(['default', 'a', 'T']), reexport: false, as: new Map() },
      { spec: './n', names: '*', reexport: false, as: new Map() },
      { spec: './c', names: new Set(['c']), reexport: true, as: new Map([['c', 'c']]) },
      { spec: './all', names: '*', reexport: true, as: new Map() },
    ])
    expect([...r.own]).toEqual(['own', 'I'])
  })
})
