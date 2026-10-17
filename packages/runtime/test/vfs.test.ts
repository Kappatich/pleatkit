import { describe, expect, it } from 'vitest'
import { resolveSpecifier, type ResolveContext } from '../src/vfs.js'

const ctx: ResolveContext = {
  files: {
    'src/dynamic/card.tsx': '',
    'src/dynamic/parts/row.tsx': '',
    'src/dynamic/styles.css': '',
    'src/dynamic/lib/index.ts': '',
  },
  alias: { '@': 'src' },
  externals: ['react', 'react/jsx-runtime', '@/components/ui/button', '@/lib/utils'],
  externalPatterns: ['react', 'react/jsx-runtime', '@/components/ui/*', '@/lib/utils'],
}

describe('resolveSpecifier', () => {
  const r = (spec: string, importer = 'src/dynamic/card.tsx') => resolveSpecifier(spec, importer, ctx)

  it('resolves relative files with extension probing', () => {
    expect(r('./parts/row')).toEqual({ kind: 'file', path: 'src/dynamic/parts/row.tsx' })
    expect(r('../card', 'src/dynamic/parts/row.tsx')).toEqual({ kind: 'file', path: 'src/dynamic/card.tsx' })
    expect(r('./styles.css')).toEqual({ kind: 'file', path: 'src/dynamic/styles.css' })
    expect(r('./lib')).toEqual({ kind: 'file', path: 'src/dynamic/lib/index.ts' })
  })

  it('resolves the @ alias inside the dynamic zone', () => {
    expect(r('@/dynamic/parts/row')).toEqual({ kind: 'file', path: 'src/dynamic/parts/row.tsx' })
  })

  it('marks host modules as externals, including * patterns and relative paths to them', () => {
    expect(r('react')).toEqual({ kind: 'external', name: 'react' })
    expect(r('@/components/ui/button')).toEqual({ kind: 'external', name: '@/components/ui/button' })
    expect(r('@/components/ui/dialog')).toEqual({ kind: 'external', name: '@/components/ui/dialog' })
    expect(r('../lib/utils')).toEqual({ kind: 'external', name: '@/lib/utils' })
  })

  it('rejects packages and files that are not available', () => {
    expect(r('lodash')).toMatchObject({ kind: 'missing', text: expect.stringContaining('not available') })
    expect(r('./nope')).toMatchObject({ kind: 'missing', text: expect.stringContaining('Cannot resolve') })
    expect(r('@/core/secret')).toMatchObject({ kind: 'missing' })
  })
})
