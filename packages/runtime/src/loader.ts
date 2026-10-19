import { layeredCss, pageStyledClasses, withoutStyledRules } from './css-scope.js'
import { EXTERNALS_GLOBAL } from './constants.js'
import { guardModule, type GuardOptions } from './url-guard.js'
import type { CompiledBundle, ExternalEntry, ModuleNamespace } from './types.js'

/** One app instance's host modules, as compiled bundles see them (V1 B6). */
interface AppRegistry {
  require(name: string): unknown
  /** Resolve lazy externals before a bundle that needs them runs. */
  ensure(names?: string[]): Promise<void>
}

interface PleatkitGlobal {
  apps: Record<string, AppRegistry>
}

declare global {
  var __pleatkit: PleatkitGlobal | undefined
}

function globalRegistry(): PleatkitGlobal {
  const g = globalThis as Record<string, unknown>
  const current = g[EXTERNALS_GLOBAL] as Partial<PleatkitGlobal> | undefined
  if (!current || typeof current !== 'object' || !current.apps) g[EXTERNALS_GLOBAL] = { ...(current ?? {}), apps: {} }
  return g[EXTERNALS_GLOBAL] as PleatkitGlobal
}

const isLazy = (e: ExternalEntry): e is () => Promise<ModuleNamespace> => typeof e === 'function'

/**
 * Expose host modules to compiled bundles as `globalThis.__pleatkit.apps[namespace].require(name)`. Entries may
 * be lazy (`() => import('lucide-react')`, V1 B6): they are resolved by `ensure()` right before a bundle that
 * imports them runs, so a big library is loaded only when an edit uses it. `react`, `react/jsx-runtime` and
 * `react-dom` are handed out guarded (`guardModule`, DECISIONS 74.3); `guard.allowedHosts` is the manifest's list
 * of hosts `<img src>` and `<a href>` may point to (DECISIONS 63.1).
 */
export function installExternals(externals: Record<string, ExternalEntry>, namespace = 'default', guard: GuardOptions = {}): AppRegistry {
  const resolved = new Map<string, unknown>()
  const pending = new Map<string, Promise<void>>()
  // DECISIONS 74.3: React's element factories reach edits guarded, so a URL from data stays on the app's origin
  // (or on a host of allowedHosts, 63.1)
  const wrap = (name: string, ns: ModuleNamespace) => Object.assign(Object.create(null), guardModule(name, ns as Record<string, unknown>, guard), { __esModule: true })
  const registry: AppRegistry = {
    require(name) {
      const hit = resolved.get(name)
      if (hit) return hit
      const entry = externals[name]
      if (!entry) throw new Error(`pleatkit: module "${name}" is not provided by the host app (add it to externals)`)
      if (isLazy(entry)) throw new Error(`pleatkit: lazy module "${name}" was not loaded before the edit ran`)
      // Marked as an ES module so esbuild's interop maps `import x from` to the real default export.
      const mod = wrap(name, entry)
      resolved.set(name, mod)
      return mod
    },
    async ensure(names) {
      const list = names ?? Object.keys(externals)
      await Promise.all(
        list.map((name) => {
          const entry = externals[name]
          if (!entry || !isLazy(entry) || resolved.has(name)) return undefined
          let p = pending.get(name)
          if (!p) {
            p = entry().then((ns) => void resolved.set(name, wrap(name, ns)))
            p.catch(() => pending.delete(name))
            pending.set(name, p)
          }
          return p
        }),
      )
    },
  }
  globalRegistry().apps[namespace] = registry
  return registry
}

export function registryFor(namespace = 'default'): AppRegistry | null {
  return globalRegistry().apps[namespace] ?? null
}

/** Evaluate a compiled ESM bundle from a `blob:` URL (browser compile mode) and return its `modules` export. */
export async function importBundle(js: string): Promise<Record<string, ModuleNamespace>> {
  const url = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }))
  try {
    const mod = (await import(/* @vite-ignore */ url)) as { modules?: Record<string, ModuleNamespace> }
    if (!mod.modules) throw new Error('pleatkit: compiled bundle has no `modules` export')
    return mod.modules
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * Evaluate a server bundle from its same-origin URL (compile: 'server', V1 B1) with Subresource Integrity: a
 * `<script type="module" integrity>` runs it only if its bytes match the signed digest, and the following
 * `import()` of the same URL returns that already evaluated module from the module map, so what runs is
 * exactly what was verified. Needs neither `blob:` nor WebAssembly in the CSP.
 */
export async function importUrl(url: string, integrity?: string): Promise<Record<string, ModuleNamespace>> {
  const abs = new URL(url, typeof document !== 'undefined' ? document.baseURI : undefined).href
  if (typeof document !== 'undefined' && integrity) {
    await new Promise<void>((resolve, reject) => {
      const el = document.createElement('script')
      el.type = 'module'
      el.src = abs
      el.integrity = integrity
      el.crossOrigin = 'anonymous'
      el.setAttribute('data-pleatkit-bundle', '')
      // the element stays as a record of what ran and with which digest; the module cache of the engine keeps
      // their number small (a version already loaded is not imported again)
      el.onload = () => resolve()
      el.onerror = () => {
        el.remove()
        reject(new Error(`pleatkit: the bundle ${url} failed to load or did not match its signed digest`))
      }
      document.head.appendChild(el)
    })
  }
  const mod = (await import(/* @vite-ignore */ abs)) as { modules?: Record<string, ModuleNamespace> }
  if (!mod.modules) throw new Error('pleatkit: compiled bundle has no `modules` export')
  return mod.modules
}

const STYLE_ATTR = 'data-pleatkit-css'

/** The runtime CSS of edits, one `<style>` per app instance (V1 B6). */
export function applyCss(rawCss: string, namespace = 'default'): void {
  if (typeof document === 'undefined') return
  // stage 5 block 4: a utility the page already styles stays the page's, in Tailwind's order (css-scope.ts)
  const css = layeredCss(withoutStyledRules(rawCss, pageStyledClasses(document)))
  let el = document.querySelector<HTMLStyleElement>(`style[${STYLE_ATTR}="${CSS.escape(namespace)}"]`)
  if (!css) {
    el?.remove()
    return
  }
  if (!el) {
    el = document.createElement('style')
    el.setAttribute(STYLE_ATTR, namespace)
    document.head.appendChild(el)
  }
  el.textContent = css
}

export type BundleLoader = (bundle: CompiledBundle) => Promise<Record<string, ModuleNamespace>>

export const defaultLoader: BundleLoader = (bundle) => (bundle.url ? importUrl(bundle.url, bundle.integrity) : importBundle(bundle.js))
