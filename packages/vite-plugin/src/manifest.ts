import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import picomatch from 'picomatch'
import { globSync } from 'tinyglobby'
import { emitDeclarations } from './declarations.js'
import { tailwindInput } from './tailwind.js'

export interface ZonesOptions {
  /** Globs (relative to project root) the agent may edit; compiled at runtime. */
  dynamic: string[]
  /** Globs the agent may read but not edit. Everything else is core. */
  readonly?: string[]
}

export interface MorphkitOptions {
  zones: ZonesOptions
  /**
   * Module specifiers that dynamic code imports from the host app instead of bundling.
   * A trailing `*` is expanded against the file system, e.g. `@/components/ui/*`.
   */
  externals?: string[]
  /** Import aliases, specifier prefix → directory relative to root. Default `{ '@': 'src' }`. */
  alias?: Record<string, string>
  /** Emit `.d.ts` for core files that dynamic/readonly code imports. Default true. */
  coreTypes?: boolean
  /**
   * CSS for classes that runtime edits introduce.
   * - `tailwind`: compile Tailwind 4 in the browser at commit (needs `tailwindcss` installed in the app).
   * - `palette` (default): no runtime CSS; pre-generate a safelist with `@source inline(...)` in your CSS.
   */
  css?: 'palette' | 'tailwind'
  /** The app's Tailwind entry CSS; its `@theme`/`@utility`/`@custom-variant` blocks feed the runtime compiler. Default `src/index.css`. */
  tailwindEntry?: string
  /** Build the iframe host for `<Dynamic isolated>` panels. Default false. */
  isolated?: boolean
  /**
   * Where edits are compiled (V1 B1). `server` (default): on the agent server, signed, loaded from
   * `/morphkit/b/…` with `import()`; the page needs neither WebAssembly nor `blob:`. `browser`: esbuild-wasm in
   * the page (falls back to the server by itself when WebAssembly cannot load).
   */
  compile?: 'server' | 'browser'
  /**
   * Public key of the app key (V1 A3, `npx morphkit keys public`): when set, the runtime runs only bundles
   * signed with it. Default: the MORPHKIT_PUBLIC_KEY environment variable at build time.
   */
  publicKey?: string
  /** Register externals as `() => import()` so big libraries load only when an edit uses them (V1 B6). Default true. */
  lazyExternals?: boolean
}

export interface ManifestFile {
  path: string
  source: string
}

export interface MorphkitManifest {
  version: 1
  dynamicRoots: string[]
  dynamic: ManifestFile[]
  readonly: ManifestFile[]
  coreTypes: ManifestFile[]
  externals: string[]
  externalPatterns: string[]
  alias: Record<string, string>
  /** Runtime CSS input for server compiles and its hash for bundle keys (V1 B1). */
  css?: { mode: 'tailwind' | 'palette'; input?: string; hash: string }
}

export const DEFAULT_EXTERNALS = ['react', 'react-dom', 'react/jsx-runtime']
const SOURCE_EXT = ['.tsx', '.ts', '.jsx', '.js', '.mts', '.mjs']
const RESOLVE_EXT = ['', ...SOURCE_EXT, '.css', ...SOURCE_EXT.map((e) => `/index${e}`)]
const IGNORE = ['**/node_modules/**', '**/dist/**', '**/*.d.ts']

export const toPosix = (p: string): string => p.split(path.sep).join('/')

/** Static directory prefix of a glob: `src/dynamic/**` → `src/dynamic/`. */
export function globRoot(glob: string): string {
  const parts = glob.split('/')
  const stat: string[] = []
  for (const part of parts) {
    if (/[*?{}[\]!]/.test(part)) break
    stat.push(part)
  }
  return stat.length === 0 ? '' : stat.join('/') + '/'
}

export function resolveOptions(options: MorphkitOptions) {
  return {
    dynamic: options.zones.dynamic,
    readonly: options.zones.readonly ?? [],
    externals: [...new Set([...DEFAULT_EXTERNALS, ...(options.externals ?? [])])],
    alias: options.alias ?? { '@': 'src' },
    coreTypes: options.coreTypes ?? true,
    css: options.css ?? 'palette',
    tailwindEntry: options.tailwindEntry ?? 'src/index.css',
    isolated: options.isolated ?? false,
    compile: options.compile ?? 'server',
    publicKey: options.publicKey ?? process.env.MORPHKIT_PUBLIC_KEY ?? null,
    lazyExternals: options.lazyExternals ?? true,
  }
}

function readFiles(root: string, globs: string[], exclude: string[] = []): ManifestFile[] {
  if (globs.length === 0) return []
  const files = globSync(globs, { cwd: root, ignore: [...IGNORE, ...exclude], onlyFiles: true })
  return files
    .map(toPosix)
    .sort()
    .map((p) => ({ path: p, source: fs.readFileSync(path.join(root, p), 'utf8') }))
}

/** Expand `@/components/ui/*` into one specifier per file found in that directory. */
export function expandExternals(root: string, patterns: string[], alias: Record<string, string>): string[] {
  const out = new Set<string>()
  for (const spec of patterns) {
    if (!spec.endsWith('*')) {
      out.add(spec)
      continue
    }
    const prefix = spec.slice(0, -1)
    const dir = aliasToPath(prefix, alias)
    if (dir === null) continue
    const files = globSync(SOURCE_EXT.map((e) => `${dir}*${e}`), { cwd: root, ignore: IGNORE })
    for (const f of files.map(toPosix).sort()) {
      const base = f.slice(dir.length).replace(/\.[^.]+$/, '')
      out.add(prefix + base)
    }
  }
  return [...out]
}

/** `@/lib/utils` → `src/lib/utils` (relative to root), or null for bare package specifiers. */
export function aliasToPath(spec: string, alias: Record<string, string>): string | null {
  for (const [key, dir] of Object.entries(alias)) {
    if (spec === key) return dir
    if (spec.startsWith(key + '/')) return dir.replace(/\/$/, '') + spec.slice(key.length)
  }
  return null
}

const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g

export function findImports(source: string): string[] {
  const out: string[] = []
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3]
    if (spec) out.push(spec)
  }
  return out
}

function resolveProjectFile(root: string, spec: string, importer: string, alias: Record<string, string>): string | null {
  let base: string | null
  if (spec.startsWith('./') || spec.startsWith('../')) base = path.posix.join(path.posix.dirname(importer), spec)
  else base = aliasToPath(spec, alias)
  if (base === null) return null
  for (const ext of RESOLVE_EXT) {
    const candidate = base + ext
    const abs = path.join(root, candidate)
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return toPosix(candidate)
  }
  return null
}

export function buildManifest(root: string, options: MorphkitOptions): MorphkitManifest {
  const o = resolveOptions(options)
  const dynamic = readFiles(root, o.dynamic)
  const readonly = readFiles(root, o.readonly, o.dynamic)
  const isDynamic = picomatch(o.dynamic)
  const isReadonly = picomatch(o.readonly)

  let coreTypes: ManifestFile[] = []
  if (o.coreTypes) {
    // Core files the agent will see through imports: emit only their declarations.
    const coreFiles = new Set<string>()
    for (const file of [...dynamic, ...readonly]) {
      for (const spec of findImports(file.source)) {
        const resolved = resolveProjectFile(root, spec, file.path, o.alias)
        if (resolved && !isDynamic(resolved) && !isReadonly(resolved) && !resolved.endsWith('.css')) {
          coreFiles.add(resolved)
        }
      }
    }
    coreTypes = emitDeclarations(root, [...coreFiles].sort(), o.alias)
  }

  return {
    version: 1,
    dynamicRoots: [...new Set(o.dynamic.map(globRoot))],
    dynamic,
    readonly,
    coreTypes,
    externals: expandExternals(root, o.externals, o.alias),
    externalPatterns: o.externals,
    alias: o.alias,
    css: cssInfo(root, o.css, o.tailwindEntry),
  }
}

function cssInfo(root: string, mode: 'tailwind' | 'palette', entry: string): MorphkitManifest['css'] {
  if (mode !== 'tailwind') return { mode: 'palette', hash: 'palette' }
  const input = tailwindInput(root, entry)
  return { mode: 'tailwind', input, hash: createHash('sha256').update(input).digest('hex').slice(0, 32) }
}
