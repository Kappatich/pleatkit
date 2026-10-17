import type { BuildFailure, Message, Plugin } from 'esbuild-wasm/esm/browser.js'
import type { CompileError, CompileResult, FileMap, MorphkitManifest } from './types.js'
import { hashFiles } from './util.js'
import { loaderFor, resolveSpecifier, type ResolveContext } from './vfs.js'

/** The subset of the esbuild API we use; satisfied by both the browser and the Node build of esbuild-wasm. */
export interface EsbuildApi {
  version: string
  build: typeof import('esbuild-wasm/esm/browser.js').build
  initialize?: typeof import('esbuild-wasm/esm/browser.js').initialize
}

export interface CompilerMetrics {
  /** Time to fetch + compile + initialize esbuild-wasm, ms. Null until initialized. */
  initMs: number | null
  wasmBytes: number | null
  wasmFromCache: boolean | null
  esbuildVersion: string | null
}

export interface CompilerOptions {
  /** URL of esbuild.wasm (from `virtual:morphkit/wasm-url`). Ignored in Node. */
  wasmURL?: string | null
  /** Override how esbuild is loaded (tests pass the Node build). */
  loadEsbuild?: () => Promise<EsbuildApi>
}

export type CompileContext = Pick<MorphkitManifest, 'alias' | 'externals' | 'externalPatterns' | 'dynamicRoots'>

/** Global accessor the compiled bundle uses to reach host modules. Set up by `installExternals`. */
export const EXTERNALS_GLOBAL = '__morphkit'
const NS_VFS = 'morphkit-vfs'
const NS_EXTERNAL = 'morphkit-external'
const NS_ENTRY = 'morphkit-entry'
const SCRIPT_RE = /\.(tsx|ts|jsx|js|mts|mjs)$/
const WASM_CACHE = 'morphkit-esbuild'

export const isScript = (path: string): boolean => SCRIPT_RE.test(path)

async function fetchWasm(url: string): Promise<{ module: WebAssembly.Module; bytes: number; fromCache: boolean }> {
  let cache: Cache | undefined
  let response: Response | undefined
  try {
    cache = await caches.open(WASM_CACHE)
    response = await cache.match(url)
  } catch {
    // Cache API unavailable (insecure context, private mode)
  }
  const fromCache = response !== undefined
  if (!response) {
    response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to load esbuild.wasm from ${url}: HTTP ${response.status}`)
    if (cache) await cache.put(url, response.clone()).catch(() => undefined)
  }
  const buffer = await response.arrayBuffer()
  return { module: await WebAssembly.compile(buffer), bytes: buffer.byteLength, fromCache }
}

/** esbuild-wasm may be initialized only once per page, so the instance is shared by all compilers. */
let shared: Promise<EsbuildApi> | null = null
export const metrics: CompilerMetrics = { initMs: null, wasmBytes: null, wasmFromCache: null, esbuildVersion: null }

async function initEsbuild(options: CompilerOptions): Promise<EsbuildApi> {
  const started = performance.now()
  if (options.loadEsbuild) {
    const api = await options.loadEsbuild()
    metrics.initMs = performance.now() - started
    metrics.esbuildVersion = api.version
    return api
  }
  if (!options.wasmURL) throw new Error('morphkit: wasmURL is not configured, cannot compile in the browser')
  const [api, wasm] = await Promise.all([import('esbuild-wasm/esm/browser.js'), fetchWasm(options.wasmURL)])
  await api.initialize({ wasmModule: wasm.module, worker: true })
  metrics.initMs = performance.now() - started
  metrics.wasmBytes = wasm.bytes
  metrics.wasmFromCache = wasm.fromCache
  metrics.esbuildVersion = api.version
  return api
}

export function getEsbuild(options: CompilerOptions): Promise<EsbuildApi> {
  if (!shared) {
    shared = initEsbuild(options)
    shared.catch(() => {
      shared = null
    })
  }
  return shared
}

function stripNamespace(file: string): string {
  return file.replace(new RegExp(`^(${NS_VFS}|${NS_EXTERNAL}|${NS_ENTRY}):`), '')
}

export function toCompileErrors(messages: Message[]): CompileError[] {
  return messages.map((m) => ({
    file: m.location ? stripNamespace(m.location.file) : '',
    line: m.location?.line ?? 0,
    // esbuild columns are 0-based; editors and humans count from 1
    column: m.location ? m.location.column + 1 : 0,
    text: m.text,
  }))
}

export function entrySource(files: FileMap, roots: string[]): string {
  const entries = Object.keys(files)
    .filter((p) => isScript(p) && roots.some((r) => p.startsWith(r)))
    .sort()
  const imports = entries.map((p, i) => `import * as m${i} from ${JSON.stringify('/' + p)}`)
  const map = entries.map((p, i) => `  ${JSON.stringify(p)}: m${i},`)
  return `${imports.join('\n')}\nexport const modules = {\n${map.join('\n')}\n}\n`
}

export function virtualFsPlugin(files: FileMap, ctx: CompileContext): Plugin {
  const resolveCtx: ResolveContext = { files, alias: ctx.alias, externals: ctx.externals, externalPatterns: ctx.externalPatterns }
  return {
    name: 'morphkit-virtual-fs',
    setup(build) {
      build.onResolve({ filter: /^morphkit:entry$/ }, () => ({ path: 'entry', namespace: NS_ENTRY }))
      build.onLoad({ filter: /.*/, namespace: NS_ENTRY }, () => ({
        contents: entrySource(files, ctx.dynamicRoots),
        loader: 'js',
        resolveDir: '/',
      }))

      build.onResolve({ filter: /.*/ }, (args) => {
        const importer = args.namespace === NS_VFS ? args.importer : ''
        const r = resolveSpecifier(args.path, importer, resolveCtx)
        if (r.kind === 'external') return { path: r.name, namespace: NS_EXTERNAL }
        if (r.kind === 'file') return { path: r.path, namespace: NS_VFS }
        return { errors: [{ text: r.text }] }
      })

      build.onLoad({ filter: /.*/, namespace: NS_VFS }, (args) => ({
        contents: files[args.path] ?? '',
        loader: loaderFor(args.path),
      }))

      // Host modules become tiny CommonJS shims; esbuild's interop then handles default and named imports.
      build.onLoad({ filter: /.*/, namespace: NS_EXTERNAL }, (args) => ({
        contents: `module.exports = globalThis.${EXTERNALS_GLOBAL}.require(${JSON.stringify(args.path)})`,
        loader: 'js',
      }))
    },
  }
}

export class Compiler {
  constructor(
    private readonly ctx: CompileContext,
    private readonly options: CompilerOptions = {},
  ) {}

  init(): Promise<EsbuildApi> {
    return getEsbuild(this.options)
  }

  get metrics(): CompilerMetrics {
    return { ...metrics }
  }

  async compile(files: FileMap): Promise<CompileResult> {
    const hash = await hashFiles(files)
    const esbuild = await this.init()
    const started = performance.now()
    try {
      const result = await esbuild.build({
        entryPoints: ['morphkit:entry'],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        outdir: '/out',
        jsx: 'automatic',
        sourcemap: 'inline',
        logLevel: 'silent',
        plugins: [virtualFsPlugin(files, this.ctx)],
      })
      const js = result.outputFiles.find((f) => f.path.endsWith('.js'))?.text ?? ''
      const css = result.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? ''
      return { ok: true, errors: [], warnings: toCompileErrors(result.warnings), hash, timeMs: performance.now() - started, bundle: { js, css } }
    } catch (e) {
      const failure = e as Partial<BuildFailure>
      if (!Array.isArray(failure.errors)) throw e
      return {
        ok: false,
        errors: toCompileErrors(failure.errors),
        warnings: toCompileErrors(failure.warnings ?? []),
        hash,
        timeMs: performance.now() - started,
      }
    }
  }
}
