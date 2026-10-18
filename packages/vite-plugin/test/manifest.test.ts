import fs from 'node:fs'
import os from 'node:os'
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

describe('zone globs are validated (code review 06 item 11)', () => {
  it('normalizes ./ and backslashes, refuses globs that cannot work', async () => {
    const { normalizeZones } = await import('../src/manifest.js')
    expect(normalizeZones(['./src/dynamic/**', String.raw`src\readonly\**`], 'dynamic')).toEqual(['src/dynamic/**', 'src/readonly/**'])
    expect(() => normalizeZones(['/abs/src/**'], 'dynamic')).toThrow(/zones.dynamic/)
    expect(() => normalizeZones(['../other/**'], 'readonly')).toThrow(/leaves the project/)
    expect(() => normalizeZones(['**/*.tsx'], 'dynamic')).toThrow(/no fixed directory/)
  })
})

describe('digests for the agent prompt (brainstorm 04 §1, 05 #10)', () => {
  it('one line per design-system component and the readonly data contract', async () => {
    const { designSystemDigest, dataContractsDigest } = await import('../src/manifest.js')
    const button = `import * as React from 'react'
interface ButtonProps { variant?: 'default' | 'destructive'; size?: 'sm' | 'lg' }
export function Button({ variant }: ButtonProps) { return null }
export const Card = (p: { title: string }) => null
function internal() {}`
    expect(designSystemDigest([{ path: 'src/components/ui/button.tsx', source: button }])).toBe(
      "src/components/ui/button: Button(variant?: 'default' | 'destructive', size?: 'sm' | 'lg'); Card(title: string)",
    )
    const api = `export interface Customer { id: string; name: string }
export const api = { listCustomers(): Promise<Customer[]> { return fetch('/api').then((r) => r.json()) }, rename: (id: string, name: string): Promise<void> => Promise.resolve() }`
    const digest = dataContractsDigest([{ path: 'src/readonly/api.ts', source: api }])
    expect(digest).toContain('interface Customer { id: string; name: string }')
    expect(digest).toContain('api: { listCustomers(): Promise<Customer[]>; rename(id: string, name: string): Promise<void> }')
    expect(digest).not.toContain('fetch(')
  })

  it('shows component variants: cva() tables, local unions, export lists and default exports (DECISIONS 73.7)', async () => {
    const { designSystemDigest } = await import('../src/manifest.js')
    // shadcn (new style): props as an intersection, exported at the bottom
    const shadcn = `import { cva, type VariantProps } from 'class-variance-authority'
const badgeVariants = cva('inline-flex', { variants: { variant: { default: 'a', secondary: 'b', 'outline': 'c' } }, defaultVariants: { variant: 'default' } })
function Badge({ className, variant, asChild = false, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) { return null }
export { Badge, badgeVariants }`
    // shadcn (old style): an interface extending the DOM attributes and the variants
    const old = `import type { HTMLAttributes } from 'react'
export const buttonVariants = cva('x', { variants: { variant: { default: '', ghost: '' }, size: { sm: '', lg: '' } } })
export interface ButtonProps extends HTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}
export function Button({ variant, size }: ButtonProps) { return null }`
    // TailAdmin: React.FC with an interface whose members name local unions, default export
    const tail = `type BadgeColor = "primary" | "success" | "error"; // the colours
interface BadgeProps {
  color?: BadgeColor; // colour
  size?: "sm" | "md";
  children: React.ReactNode;
}
const Badge: React.FC<BadgeProps> = ({ color = "primary", children }) => null
export default Badge`
    const digest = designSystemDigest([
      { path: 'src/components/ui/badge.tsx', source: shadcn },
      { path: 'src/components/ui/button.tsx', source: old },
      { path: 'src/components/ui/badge/Badge.tsx', source: tail },
    ]).split('\n')
    expect(digest[0]).toBe(`src/components/ui/badge: Badge(variant?: "default" | "secondary" | "outline", asChild?: boolean, …React.ComponentProps<'span'>)`)
    expect(digest[1]).toBe('src/components/ui/button: Button(variant?: "default" | "ghost", size?: "sm" | "lg", …HTMLAttributes<HTMLButtonElement>)')
    expect(digest[2]).toBe('src/components/ui/badge/Badge: Badge(color?: "primary" | "success" | "error", size?: "sm" | "md", children: React.ReactNode)')
  })

  it('carries the app\'s ambient declarations (module augmentations) as core types', async () => {
    const { ambientDeclarations } = await import('../src/manifest.js')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-ambient-'))
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src', 'table.d.ts'), "import '@tanstack/react-table'\ndeclare module '@tanstack/react-table' {\n  interface ColumnMeta<TData, TValue> { className?: string }\n}\n")
    fs.writeFileSync(path.join(dir, 'src', 'vite-env.d.ts'), '/// <reference types="vite/client" />\n')
    expect(ambientDeclarations(dir).map((f) => f.path)).toEqual(['src/table.d.ts'])
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
