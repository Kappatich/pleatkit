import * as esbuild from 'esbuild'
import { Compiler, isWritablePath, type CompileContextWire, type CompileError, type CompiledBundle, type EsbuildApi, type FileMap } from '@morphkit/runtime/compiler'

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
  /** Selectors of protected elements and the release's original files (brainstorm 05 #20). */
  protected?: string[]
  base?: FileMap
}

/** Extra check after a clean compile (type errors against the app's `.d.ts`, brainstorm 05 #4). */
export type TypecheckFn = (files: FileMap, input: WorkspaceInput) => Promise<CompileError[]>

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

  constructor(
    readonly input: WorkspaceInput,
    private readonly typecheck: TypecheckFn | null = null,
  ) {
    this.files = { ...input.files }
    this.original = { ...input.files }
    this.compiler = new Compiler(
      { ...input.context, ...(input.protected?.length ? { protected: input.protected, base: input.base ?? {} } : {}) },
      { loadEsbuild: nativeEsbuild, sourcemap: false },
    )
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
    return isWritablePath(path, this.input.context.dynamicRoots)
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

  /**
   * The shared `check` of @morphkit/runtime (code review 06 item 12): the same bundle step, static rules,
   * protected elements and default-export rule as the browser, with native esbuild.
   */
  async check(): Promise<CheckResult> {
    const started = performance.now()
    const result = await this.compiler.compile(this.files, { components: this.input.components })
    this.lastBundle = result.ok && result.bundle ? result.bundle : null
    this.lastHash = result.hash
    let errors = result.errors
    if (result.ok && this.typecheck) errors = await this.typecheck(this.files, this.input)
    this.lastCheck = { ok: errors.length === 0, errors, timeMs: performance.now() - started }
    if (errors.length) this.lastBundle = null
    this.dirtySinceCheck = false
    return this.lastCheck
  }
}

/** Errors for the model: deduplicated, at most 10 (brainstorm 04 §2), with how many more there were. */
export const formatErrors = (errors: CompileError[]): string => {
  const lines = [...new Set(errors.map((e) => (e.line ? `${e.file}:${e.line}:${e.column} ${e.text}` : `${e.file ? e.file + ': ' : ''}${e.text}`)))]
  return lines.length > 10 ? [...lines.slice(0, 10), `… and ${lines.length - 10} more`].join('\n') : lines.join('\n')
}
