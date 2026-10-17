import * as esbuild from 'esbuild-wasm'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { Compiler, type EsbuildApi } from '../src/compiler.js'
import type { BundleLoader } from '../src/loader.js'
import type { FileMap, MorphkitConfig, MorphkitManifest } from '../src/types.js'

export const BASE: FileMap = {
  'src/dynamic/customer-card.tsx': `import { cn } from '@/lib/utils'
export default function CustomerCard({ name }: { name: string }) {
  return <div className={cn('card')}>{name}</div>
}`,
  'src/dynamic/deals-table.tsx': `import { useState } from 'react'
export default function DealsTable() {
  const [n] = useState(3)
  return <table><tbody><tr><td>{n} deals</td></tr></tbody></table>
}`,
  'src/dynamic/dashboard-panels.tsx': `import React from 'react'
import { Row } from './parts/row'
export default function DashboardPanels() {
  return <React.Fragment><Row label="Revenue" /></React.Fragment>
}`,
  'src/dynamic/parts/row.tsx': `export function Row({ label }: { label: string }) {
  return <p>{label}</p>
}`,
}

export const manifest: MorphkitManifest = {
  version: 1,
  dynamicRoots: ['src/dynamic/'],
  dynamic: Object.entries(BASE).map(([path, source]) => ({ path, source })),
  readonly: [],
  coreTypes: [],
  externals: ['react', 'react-dom', 'react/jsx-runtime', '@/lib/utils'],
  externalPatterns: ['react', 'react-dom', 'react/jsx-runtime', '@/lib/utils'],
  alias: { '@': 'src' },
}

const utils = { cn: (...c: string[]) => c.filter(Boolean).join(' ') }

export function makeConfig(overrides: Partial<MorphkitConfig> = {}, base: FileMap = BASE): MorphkitConfig {
  const fallback: MorphkitConfig['fallback'] = {}
  // Panels have a default export; helper modules (parts/) only named ones, like in a real app.
  for (const path of Object.keys(base)) {
    fallback[path] = path.includes('/parts/') ? { Row: () => null } : { default: Object.assign(() => null, { base: path }) }
  }
  return {
    manifest: { ...manifest, dynamic: Object.entries(base).map(([path, source]) => ({ path, source })) },
    externals: { react: React as never, 'react-dom': {}, 'react/jsx-runtime': jsxRuntime as never, '@/lib/utils': utils },
    fallback,
    wasmURL: null,
    ...overrides,
  }
}

export function nodeCompiler(): Compiler {
  return new Compiler(manifest, { loadEsbuild: async () => esbuild as unknown as EsbuildApi })
}

/** Node can import ESM from data: URLs, which stands in for blob: URLs in the browser. */
export const nodeLoader: BundleLoader = async (bundle) => {
  const url = 'data:text/javascript;base64,' + Buffer.from(bundle.js).toString('base64')
  const mod = (await import(url)) as { modules: Record<string, Record<string, unknown>> }
  return mod.modules
}
