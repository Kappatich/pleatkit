import { EXTERNALS_GLOBAL } from './constants.js'
import type { CompiledBundle, ModuleNamespace } from './types.js'

interface MorphkitGlobal {
  externals: Record<string, ModuleNamespace>
  require(name: string): unknown
}

declare global {
  var __morphkit: MorphkitGlobal | undefined
}

/** Expose host modules to compiled bundles as `globalThis.__morphkit.require(name)`. */
export function installExternals(externals: Record<string, ModuleNamespace>): void {
  const cache = new Map<string, unknown>()
  const g: MorphkitGlobal = {
    externals,
    require(name) {
      const hit = cache.get(name)
      if (hit) return hit
      const ns = externals[name]
      if (!ns) throw new Error(`morphkit: module "${name}" is not provided by the host app (add it to externals)`)
      // Marked as an ES module so esbuild's interop maps `import x from` to the real default export.
      const mod = Object.assign(Object.create(null), ns, { __esModule: true })
      cache.set(name, mod)
      return mod
    },
  }
  ;(globalThis as Record<string, unknown>)[EXTERNALS_GLOBAL] = g
}

/** Evaluate a compiled ESM bundle and return its `modules` export (path → namespace). */
export async function importBundle(js: string): Promise<Record<string, ModuleNamespace>> {
  const url = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }))
  try {
    const mod = (await import(/* @vite-ignore */ url)) as { modules?: Record<string, ModuleNamespace> }
    if (!mod.modules) throw new Error('morphkit: compiled bundle has no `modules` export')
    return mod.modules
  } finally {
    URL.revokeObjectURL(url)
  }
}

const STYLE_ATTR = 'data-morphkit-css'

export function applyCss(css: string): void {
  if (typeof document === 'undefined') return
  let el = document.querySelector<HTMLStyleElement>(`style[${STYLE_ATTR}]`)
  if (!css) {
    el?.remove()
    return
  }
  if (!el) {
    el = document.createElement('style')
    el.setAttribute(STYLE_ATTR, '')
    document.head.appendChild(el)
  }
  el.textContent = css
}

export type BundleLoader = (bundle: CompiledBundle) => Promise<Record<string, ModuleNamespace>>

export const defaultLoader: BundleLoader = (bundle) => importBundle(bundle.js)
