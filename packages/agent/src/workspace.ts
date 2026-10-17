import * as esbuild from 'esbuild'
import {
  Compiler,
  isScript,
  toCompileErrors,
  virtualFsPlugin,
  type CompileContextWire,
  type CompileError,
  type CompiledBundle,
  type EsbuildApi,
  type FileMap,
} from '@morphkit/runtime/compiler'
import { staticCheck } from './static-check.js'

const WRITABLE_EXT = /\.(tsx|ts|jsx|js|css|json)$/
const nativeEsbuild = async () => esbuild as unknown as EsbuildApi

export class ZoneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZoneError'
  }
}

export interface CheckResult {
  ok: boolean
  errors: CompileError[]
  timeMs: number
}

export interface WorkspaceInput {
  files: FileMap
  readonly: FileMap
  coreTypes: FileMap
  context: CompileContextWire
  /** Dynamic files that must keep a default export. */
  components: string[]
}

/**
 * The agent's in-memory copy of the user's files. Writes are allowed only inside the dynamic zone;
 * `check` compiles with native esbuild through the same virtual-fs plugin and externals as the browser,
 * then verifies that every mounted panel still exports a default component.
 */
export class Workspace {
  private files: FileMap
  private readonly original: FileMap
  private readonly compiler: Compiler
  private dirtySinceCheck = false
  lastCheck: CheckResult | null = null
  /** Bundle of the last successful check (server compile reuses it, V1 B1). No source map: it is served as is. */
  lastBundle: CompiledBundle | null = null
  lastHash: string | null = null

  constructor(readonly input: WorkspaceInput) {
    this.files = { ...input.files }
    this.original = { ...input.files }
    this.compiler = new Compiler(input.context, { loadEsbuild: nativeEsbuild, sourcemap: false })
  }

  zoneOf(path: string): 'dynamic' | 'readonly' | 'core-types' | null {
    if (path in this.files) return 'dynamic'
    if (path in this.input.readonly) return 'readonly'
    if (path in this.input.coreTypes) return 'core-types'
    return null
  }

  list(): { path: string; zone: string; bytes: number }[] {
    const rows = [
      ...Object.entries(this.files).map(([path, s]) => ({ path, zone: 'dynamic (writable)', bytes: s.length })),
      ...Object.entries(this.input.readonly).map(([path, s]) => ({ path, zone: 'readonly', bytes: s.length })),
      ...Object.entries(this.input.coreTypes).map(([path, s]) => ({ path, zone: 'core (types only)', bytes: s.length })),
    ]
    return rows.sort((a, b) => a.path.localeCompare(b.path))
  }

  read(path: string): string {
    const src = this.files[path] ?? this.input.readonly[path] ?? this.input.coreTypes[path]
    if (src === undefined) throw new Error(`No such file: ${path}. Call list_files to see what exists.`)
    return src
  }

  isWritable(path: string): boolean {
    if (path.includes('..') || path.startsWith('/') || path.includes('\\')) return false
    if (!WRITABLE_EXT.test(path)) return false
    return this.input.context.dynamicRoots.some((r) => path.startsWith(r))
  }

  write(path: string, content: string): void {
    if (!this.isWritable(path)) {
      const zone = this.zoneOf(path)
      throw new ZoneError(
        `"${path}" is ${zone ? `in the ${zone} zone` : 'outside the dynamic zone'}; only files under ${this.input.context.dynamicRoots.join(', ')} can be written`,
      )
    }
    this.files[path] = content
    this.dirtySinceCheck = true
  }

  get changed(): boolean {
    return Object.keys(this.changedFiles()).length > 0 || this.deleted().length > 0
  }

  get needsCheck(): boolean {
    return this.dirtySinceCheck || this.lastCheck === null
  }

  changedFiles(): FileMap {
    const out: FileMap = {}
    for (const [p, s] of Object.entries(this.files)) if (this.original[p] !== s) out[p] = s
    return out
  }

  deleted(): string[] {
    return Object.keys(this.original).filter((p) => !(p in this.files))
  }

  snapshot(): FileMap {
    return { ...this.files }
  }

  async check(): Promise<CheckResult> {
    const started = performance.now()
    const result = await this.compiler.compile(this.files)
    this.lastBundle = result.ok && result.bundle ? result.bundle : null
    this.lastHash = result.hash
    let errors = result.errors
    if (result.ok) errors = await this.missingDefaults()
    // static rules (no eval, no remote requests, allowed imports only, ...): refused like compile errors
    errors = [...errors, ...staticCheck(this.files, this.input.context)]
    this.lastCheck = { ok: errors.length === 0, errors, timeMs: performance.now() - started }
    this.dirtySinceCheck = false
    return this.lastCheck
  }

  /** Static export analysis: one esbuild pass with every panel as an entry point and a metafile. */
  private async missingDefaults(): Promise<CompileError[]> {
    const required = this.input.components.filter(isScript)
    const missing: CompileError[] = required
      .filter((p) => !(p in this.files))
      .map((p) => ({ file: p, line: 0, column: 0, text: `${p} was removed, but a <Dynamic> panel needs it` }))
    const present = required.filter((p) => p in this.files)
    if (present.length === 0) return missing
    try {
      const r = await esbuild.build({
        entryPoints: present.map((p) => '/' + p),
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'browser',
        outdir: '/out',
        jsx: 'automatic',
        metafile: true,
        logLevel: 'silent',
        plugins: [virtualFsPlugin(this.files, this.input.context) as unknown as esbuild.Plugin],
      })
      const exportsByEntry = new Map<string, string[]>()
      for (const out of Object.values(r.metafile.outputs)) {
        if (out.entryPoint) exportsByEntry.set(out.entryPoint.replace(/^[\w-]+:/, '').replace(/^\//, ''), out.exports)
      }
      for (const p of present) {
        if (!(exportsByEntry.get(p) ?? []).includes('default')) missing.push({ file: p, line: 0, column: 0, text: `no default export in ${p}` })
      }
    } catch (e) {
      const failure = e as { errors?: esbuild.Message[] }
      if (Array.isArray(failure.errors)) return [...missing, ...toCompileErrors(failure.errors as never)]
      throw e
    }
    return missing
  }
}

export const formatErrors = (errors: CompileError[]): string =>
  errors.map((e) => (e.line ? `${e.file}:${e.line}:${e.column} ${e.text}` : `${e.file ? e.file + ': ' : ''}${e.text}`)).join('\n')
