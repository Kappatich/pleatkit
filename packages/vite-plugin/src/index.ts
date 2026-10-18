import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type { IncomingMessage, ServerResponse } from 'node:http'
import picomatch from 'picomatch'
import { version as viteVersion, type Connect, type Plugin, type ResolvedConfig, type ViteDevServer } from 'vite'
import { buildIsolatedHost } from './isolated.js'
import { aliasToPath, buildManifest, resolveOptions, toPosix, type PleatkitManifest, type PleatkitOptions } from './manifest.js'
import { generateTailwindModule } from './tailwind.js'
import { track } from './telemetry.js'

export type { PleatkitManifest, PleatkitOptions, ManifestFile, ZonesOptions } from './manifest.js'
export { buildManifest, expandExternals, globRoot, findImports, normalizeZones, designSystemDigest, dataContractsDigest } from './manifest.js'
export { extractTailwindBlocks, generateTailwindModule } from './tailwind.js'
export { buildIsolatedHost } from './isolated.js'
export { track, telemetryStatus, sanitizeProps, TELEMETRY_ENDPOINT, type TelemetryOptions, type TelemetryProps } from './telemetry.js'

export const MANIFEST_FILE = 'pleatkit.manifest.json'
/** Version reported in telemetry events (F8). */
export const PLUGIN_VERSION = '0.3.0'
/** Dev-server path of the isolated-panel host script (under `base`). */
export const ISOLATED_DEV_PATH = '@pleatkit/isolated-host.js'
/** Built file name prefix of the isolated-panel host script (`assets/pleatkit-isolated-host-<hash>.js`). */
export const ISOLATED_FILE_PREFIX = 'pleatkit-isolated-host-'

/**
 * The sandboxed frame of an isolated panel has an opaque origin (`Origin: null`), and loads the host script
 * with `crossorigin="anonymous"`: the script must be served with CORS. Production hosting must send the same
 * header for this one file (see README, "Content Security Policy").
 */
export function isolatedCorsMiddleware(): Connect.NextHandleFunction {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url && (req.url.includes(ISOLATED_FILE_PREFIX) || req.url.includes(ISOLATED_DEV_PATH))) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    }
    next()
  }
}

const MODULES = [
  'virtual:pleatkit',
  'virtual:pleatkit/manifest',
  'virtual:pleatkit/externals',
  'virtual:pleatkit/fallback',
  'virtual:pleatkit/wasm-url',
  'virtual:pleatkit/css',
  'virtual:pleatkit/tailwind',
  'virtual:pleatkit/isolated',
] as const
type VirtualId = (typeof MODULES)[number]
const RESOLVED_PREFIX = '\0'

/** Import specifier that the app's module graph resolves to the same module as the core code uses. */
function importPath(root: string, spec: string, alias: Record<string, string>): string {
  const rel = aliasToPath(spec, alias)
  return rel === null ? spec : toPosix(path.join(root, rel))
}

/**
 * The externals registry. Lazy (default, V1 B6): `spec: () => import(spec)`, so a library only edits use (an
 * icon set, a chart library) is loaded when such an edit runs, not with the app; modules the app imports
 * anyway resolve to the chunk it already has.
 */
export function generateExternals(manifest: PleatkitManifest, root: string, lazy = false): string {
  const lines: string[] = []
  const entries: string[] = []
  manifest.externals.forEach((spec, i) => {
    const from = JSON.stringify(importPath(root, spec, manifest.alias))
    if (lazy) {
      entries.push(`  ${JSON.stringify(spec)}: () => import(${from}),`)
    } else {
      lines.push(`import * as e${i} from ${from}`)
      entries.push(`  ${JSON.stringify(spec)}: e${i},`)
    }
  })
  return `${lines.join('\n')}\nexport default {\n${entries.join('\n')}\n}\n`
}

export function generateFallback(manifest: PleatkitManifest, root: string): string {
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

/** Absolute path of esbuild.wasm as installed next to @pleatkit/runtime (falls back to the app root). */
function findWasm(root: string): string | null {
  const bases = [path.join(root, 'package.json')]
  try {
    bases.unshift(createRequire(path.join(root, 'package.json')).resolve('@pleatkit/runtime/package.json'))
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

/* eslint-disable @typescript-eslint/no-explicit-any -- hook types must not name a particular Vite version */
/**
 * The plugin object as seen by the app's vite.config. Hooks are typed loosely on purpose: the real hooks are
 * checked against this package's Vite, but the declared type must also be assignable to the app's Vite
 * (6 or 7), including when pleatkit is linked from a local checkout whose own Vite differs.
 */
export interface PleatkitVitePlugin {
  name: 'pleatkit'
  enforce: 'pre'
  api: { options: PleatkitOptions }
  config: (...args: any[]) => any
  configResolved: (...args: any[]) => any
  resolveId: (...args: any[]) => any
  load: (...args: any[]) => any
  configureServer: (...args: any[]) => any
  configurePreviewServer: (...args: any[]) => any
  buildStart: (...args: any[]) => any
  generateBundle: (...args: any[]) => any
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export default function pleatkit(options: PleatkitOptions): PleatkitVitePlugin {
  return createPlugin(options) as unknown as PleatkitVitePlugin
}

function createPlugin(options: PleatkitOptions): Plugin {
  const o = resolveOptions(options)
  let config: ResolvedConfig
  let root = process.cwd()
  let manifest: PleatkitManifest | null = null
  let server: ViteDevServer | null = null
  let isolatedCode: Promise<string> | null = null
  const inZones = picomatch([...o.dynamic, ...o.readonly])
  let tracked = false

  const getManifest = (): PleatkitManifest => (manifest ??= buildManifest(root, options))

  const hostCode = () =>
    (isolatedCode ??= buildIsolatedHost(root, getManifest(), config.command === 'build').catch((e: Error) => {
      isolatedCode = null
      throw e
    }))

  const load = async (id: VirtualId, emit: (fileName: string, source: string) => void): Promise<string> => {
    switch (id) {
      case 'virtual:pleatkit':
        return [
          `export { default as manifest } from 'virtual:pleatkit/manifest'`,
          `export { default as externals } from 'virtual:pleatkit/externals'`,
          `export { default as fallback } from 'virtual:pleatkit/fallback'`,
          `export { default as wasmURL } from 'virtual:pleatkit/wasm-url'`,
          `export { default as css } from 'virtual:pleatkit/css'`,
          `export { default as isolated } from 'virtual:pleatkit/isolated'`,
          `export const compile = ${JSON.stringify(o.compile)}`,
          `export const publicKey = ${JSON.stringify(o.publicKey)}`,
          // development builds keep an inline source map for edits; production ones do not (code review 06 item 7)
          `export const dev = ${JSON.stringify(config.command === 'serve')}`,
          `export const isolateEdits = ${JSON.stringify(o.isolateEdits)}`,
          `export const sendDomText = ${JSON.stringify(o.sendDomText)}`,
        ].join('\n')
      case 'virtual:pleatkit/manifest': {
        // the agent's prompt context (74.6) is for the server, not the page
        const { agentContext: _context, ...client } = getManifest()
        return `export default ${JSON.stringify(client)}`
      }
      case 'virtual:pleatkit/externals':
        return generateExternals(getManifest(), root, o.lazyExternals)
      case 'virtual:pleatkit/fallback':
        return generateFallback(getManifest(), root)
      case 'virtual:pleatkit/wasm-url': {
        const wasm = findWasm(root)
        if (!wasm) {
          config.logger.warn('[pleatkit] esbuild-wasm not found; runtime compilation will be unavailable')
          return 'export default null'
        }
        return `export { default } from ${JSON.stringify(toPosix(wasm) + '?url')}`
      }
      case 'virtual:pleatkit/css':
        return o.css === 'tailwind'
          ? `export default { mode: 'tailwind', load: () => import('virtual:pleatkit/tailwind') }`
          : `export default { mode: 'palette', load: null }`
      case 'virtual:pleatkit/tailwind':
        return generateTailwindModule(root, o.tailwindEntry)
      case 'virtual:pleatkit/isolated': {
        if (!o.isolated) return `export default null`
        // A separate classic script, never inlined (DECISIONS item 16): works under a strict CSP.
        if (config.command !== 'build') return `export default { url: ${JSON.stringify(config.base + ISOLATED_DEV_PATH)} }`
        const code = await hostCode()
        const fileName = `${config.build.assetsDir}/${ISOLATED_FILE_PREFIX}${createHash('sha256').update(code).digest('hex').slice(0, 10)}.js`
        emit(fileName, code)
        return `export default { url: ${JSON.stringify(config.base + fileName)} }`
      }
    }
  }

  return {
    name: 'pleatkit',
    enforce: 'pre',
    /** The options as given, for tools such as `pleatkit doctor` that read the app's vite.config. */
    api: { options },

    config(userConfig) {
      const appRoot = path.resolve(userConfig.root ?? process.cwd())
      const include: string[] = []
      try {
        const req = createRequire(path.join(appRoot, 'package.json'))
        createRequire(req.resolve('@pleatkit/runtime/package.json')).resolve('esbuild-wasm/esm/browser.js')
        // The compiler is imported lazily on the first check; prebundle it up front.
        include.push('@pleatkit/runtime > esbuild-wasm/esm/browser.js', '@pleatkit/runtime > idb')
        if (o.css === 'tailwind') {
          req.resolve('tailwindcss')
          include.push('tailwindcss')
        }
      } catch {
        // runtime not installed in this app
      }
      // Zone files are reached only through virtual modules, which Vite's dependency scanner skips.
      // Scan them explicitly so their dependencies don't trigger a re-optimize + page reload later.
      const entries = userConfig.optimizeDeps?.entries ?? ['**/*.html']
      return {
        optimizeDeps: {
          include,
          entries: [...(Array.isArray(entries) ? entries : [entries]), ...o.dynamic, ...o.readonly],
        },
      }
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
      return load(bare as VirtualId, (fileName, source) => this.emitFile({ type: 'asset', fileName, source }))
    },

    configureServer(s) {
      server = s
      const onChange = (file: string) => {
        const rel = toPosix(path.relative(root, file))
        const manifestPaths = new Set([...(manifest?.coreTypes ?? []).map((f) => f.path.replace(/\.d\.ts$/, ''))])
        if (!inZones(rel) && !manifestPaths.has(rel.replace(/\.[^.]+$/, '')) && rel !== o.tailwindEntry) return
        manifest = null
        isolatedCode = null
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
      if (o.isolated) {
        s.middlewares.use(`${config.base}${ISOLATED_DEV_PATH}`, (_req, res, next) => {
          hostCode().then(
            (code) => {
              res.setHeader('content-type', 'text/javascript; charset=utf-8')
              res.setHeader('cache-control', 'no-cache')
              res.setHeader('Access-Control-Allow-Origin', '*')
              res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
              res.end(code)
            },
            (e: Error) => next(e),
          )
        })
      }
    },

    configurePreviewServer(s) {
      if (o.isolated) s.middlewares.use(isolatedCorsMiddleware())
    },

    buildStart() {
      manifest = null
      isolatedCode = null
      // F8: one anonymous event per build or dev start (no paths, no code; off with PLEATKIT_TELEMETRY=0)
      if (!tracked) {
        tracked = true
        const m = getManifest()
        void track(config.command === 'build' ? 'plugin.build' : 'plugin.dev', {
          compile: o.compile,
          css: o.css,
          zones: m.dynamic.length > 0,
          isolated: o.isolated,
          vite: Number(viteVersion.split('.')[0]),
        }, { source: { package: '@pleatkit/vite-plugin', version: PLUGIN_VERSION } })
      }
      if (config.command === 'build') {
        for (const f of getManifest().dynamic) this.addWatchFile(path.join(root, f.path))
      }
    },

    generateBundle() {
      const m = getManifest()
      this.emitFile({ type: 'asset', fileName: MANIFEST_FILE, source: JSON.stringify(m, null, 2) })
      // DECISIONS 74.6: what the agent's cached prompt shows of the readonly zone, and what the cap left out
      const c = m.agentContext
      if (c) {
        config.logger.info(
          `[pleatkit] agent context: ${c.files.length} declaration files, ≈ ${c.estimatedTokens} tokens (cap ${c.capTokens}; all readonly sources and core types ≈ ${c.untrimmedTokens})` +
            (c.omitted.length ? `; over the cap, left to read_file: ${c.omitted.join(', ')}` : ''),
        )
      }
    },
  }
}

