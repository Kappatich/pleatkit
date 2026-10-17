import path from 'node:path'
import { createRequire } from 'node:module'
import picomatch from 'picomatch'
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite'
import { aliasToPath, buildManifest, resolveOptions, toPosix, type MorphkitManifest, type MorphkitOptions } from './manifest.js'

export type { MorphkitManifest, MorphkitOptions, ManifestFile, ZonesOptions } from './manifest.js'
export { buildManifest, expandExternals, globRoot, findImports } from './manifest.js'

export const MANIFEST_FILE = 'morphkit.manifest.json'

const MODULES = ['virtual:morphkit', 'virtual:morphkit/manifest', 'virtual:morphkit/externals', 'virtual:morphkit/fallback', 'virtual:morphkit/wasm-url'] as const
type VirtualId = (typeof MODULES)[number]
const RESOLVED_PREFIX = '\0'

/** Import specifier that the app's module graph resolves to the same module as the core code uses. */
function importPath(root: string, spec: string, alias: Record<string, string>): string {
  const rel = aliasToPath(spec, alias)
  return rel === null ? spec : toPosix(path.join(root, rel))
}

export function generateExternals(manifest: MorphkitManifest, root: string): string {
  const lines: string[] = []
  const entries: string[] = []
  manifest.externals.forEach((spec, i) => {
    lines.push(`import * as e${i} from ${JSON.stringify(importPath(root, spec, manifest.alias))}`)
    entries.push(`  ${JSON.stringify(spec)}: e${i},`)
  })
  return `${lines.join('\n')}\nexport default {\n${entries.join('\n')}\n}\n`
}

export function generateFallback(manifest: MorphkitManifest, root: string): string {
  const lines: string[] = []
  const entries: string[] = []
  manifest.dynamic
    .filter((f) => /\.(tsx|ts|jsx|js)$/.test(f.path))
    .forEach((f, i) => {
      lines.push(`import * as f${i} from ${JSON.stringify(toPosix(path.join(root, f.path)))}`)
      entries.push(`  ${JSON.stringify(f.path)}: f${i},`)
    })
  return `${lines.join('\n')}\nexport default {\n${entries.join('\n')}\n}\n`
}

/** Absolute path of esbuild.wasm as installed next to @morphkit/runtime (falls back to the app root). */
function findWasm(root: string): string | null {
  const bases = [path.join(root, 'package.json')]
  try {
    bases.unshift(createRequire(path.join(root, 'package.json')).resolve('@morphkit/runtime/package.json'))
  } catch {
    // runtime not installed; try the app itself
  }
  for (const base of bases) {
    try {
      return createRequire(base).resolve('esbuild-wasm/esbuild.wasm')
    } catch {
      // try next
    }
  }
  return null
}

export default function morphkit(options: MorphkitOptions): Plugin {
  const o = resolveOptions(options)
  let config: ResolvedConfig
  let root = process.cwd()
  let manifest: MorphkitManifest | null = null
  let server: ViteDevServer | null = null
  const inZones = picomatch([...o.dynamic, ...o.readonly])

  const getManifest = (): MorphkitManifest => (manifest ??= buildManifest(root, options))

  const load = (id: VirtualId): string => {
    switch (id) {
      case 'virtual:morphkit':
        return [
          `export { default as manifest } from 'virtual:morphkit/manifest'`,
          `export { default as externals } from 'virtual:morphkit/externals'`,
          `export { default as fallback } from 'virtual:morphkit/fallback'`,
          `export { default as wasmURL } from 'virtual:morphkit/wasm-url'`,
        ].join('\n')
      case 'virtual:morphkit/manifest':
        return `export default ${JSON.stringify(getManifest())}`
      case 'virtual:morphkit/externals':
        return generateExternals(getManifest(), root)
      case 'virtual:morphkit/fallback':
        return generateFallback(getManifest(), root)
      case 'virtual:morphkit/wasm-url': {
        const wasm = findWasm(root)
        if (!wasm) {
          config.logger.warn('[morphkit] esbuild-wasm not found; runtime compilation will be unavailable')
          return 'export default null'
        }
        return `export { default } from ${JSON.stringify(toPosix(wasm) + '?url')}`
      }
    }
  }

  return {
    name: 'morphkit',
    enforce: 'pre',

    config(userConfig) {
      const appRoot = path.resolve(userConfig.root ?? process.cwd())
      let canPrebundle = false
      try {
        const req = createRequire(path.join(appRoot, 'package.json'))
        createRequire(req.resolve('@morphkit/runtime/package.json')).resolve('esbuild-wasm')
        canPrebundle = true
      } catch {
        // runtime not installed in this app
      }
      // Prebundle the lazily imported compiler so Vite doesn't re-optimize and reload on the first commit.
      return canPrebundle ? { optimizeDeps: { include: ['@morphkit/runtime > esbuild-wasm', '@morphkit/runtime > idb'] } } : {}
    },

    configResolved(resolved) {
      config = resolved
      root = toPosix(resolved.root)
    },

    resolveId(id) {
      if ((MODULES as readonly string[]).includes(id)) return RESOLVED_PREFIX + id
      return null
    },

    load(id) {
      if (!id.startsWith(RESOLVED_PREFIX)) return null
      const bare = id.slice(RESOLVED_PREFIX.length)
      if (!(MODULES as readonly string[]).includes(bare)) return null
      return load(bare as VirtualId)
    },

    configureServer(s) {
      server = s
      const onChange = (file: string) => {
        const rel = toPosix(path.relative(root, file))
        const manifestPaths = new Set([...(manifest?.coreTypes ?? []).map((f) => f.path.replace(/\.d\.ts$/, ''))])
        if (!inZones(rel) && !manifestPaths.has(rel.replace(/\.[^.]+$/, ''))) return
        manifest = null
        for (const id of MODULES) {
          const mod = server?.moduleGraph.getModuleById(RESOLVED_PREFIX + id)
          if (mod) server?.moduleGraph.invalidateModule(mod)
        }
      }
      s.watcher.on('change', onChange)
      s.watcher.on('add', onChange)
      s.watcher.on('unlink', onChange)
      s.middlewares.use(`/${MANIFEST_FILE}`, (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(getManifest(), null, 2))
      })
    },

    buildStart() {
      manifest = null
      if (config.command === 'build') {
        for (const f of getManifest().dynamic) this.addWatchFile(path.join(root, f.path))
      }
    },

    generateBundle() {
      this.emitFile({ type: 'asset', fileName: MANIFEST_FILE, source: JSON.stringify(getManifest(), null, 2) })
    },
  }
}

