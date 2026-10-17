/** path (relative to project root, posix) → source */
export type FileMap = Record<string, string>

export type SnapshotAuthor = 'base' | 'agent' | 'user' | 'admin'
export type SnapshotStatus = 'applied' | 'rejected' | 'pending-admin'

export interface Snapshot {
  id: string
  parentId: string | null
  userId: string
  /** Full snapshot of the dynamic zone. */
  files: FileMap
  message: string
  author: SnapshotAuthor
  createdAt: string
  status: SnapshotStatus
}

export interface CompiledBundle {
  js: string
  css: string
}

export interface BundleCache {
  get(hash: string): Promise<CompiledBundle | null>
  put(hash: string, bundle: CompiledBundle): Promise<void>
}

export interface SnapshotStore {
  head(userId: string): Promise<Snapshot | null>
  get(id: string): Promise<Snapshot>
  /** Newest first. */
  list(userId: string, limit?: number): Promise<Snapshot[]>
  put(snapshot: Snapshot): Promise<void>
  setHead(userId: string, id: string): Promise<void>
  bundleCache: BundleCache
}

export interface CompileError {
  file: string
  line: number
  column: number
  text: string
}

export interface CompileResult {
  ok: boolean
  errors: CompileError[]
  warnings: CompileError[]
  /** sha256 of the sorted FileMap */
  hash: string
  timeMs: number
  bundle?: CompiledBundle
}

export interface ManifestFile {
  path: string
  source: string
}

/** Shape produced by @morphkit/vite-plugin (`virtual:morphkit/manifest`). */
export interface MorphkitManifest {
  version: 1
  dynamicRoots: string[]
  dynamic: ManifestFile[]
  readonly: ManifestFile[]
  coreTypes: ManifestFile[]
  externals: string[]
  externalPatterns: string[]
  alias: Record<string, string>
}

export type ModuleNamespace = Record<string, unknown>

/** Everything the Vite plugin generates, as `import * as config from 'virtual:morphkit'`. */
export interface MorphkitConfig {
  manifest: MorphkitManifest
  externals: Record<string, ModuleNamespace>
  fallback: Record<string, ModuleNamespace>
  wasmURL: string | null
}
