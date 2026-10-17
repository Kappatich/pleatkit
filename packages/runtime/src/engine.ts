import { Compiler, isScript, type CompilerMetrics } from './compiler.js'
import { applyCss, defaultLoader, installExternals, type BundleLoader } from './loader.js'
import type {
  CompileError,
  CompileResult,
  CompiledBundle,
  FileMap,
  ModuleNamespace,
  MorphkitConfig,
  Snapshot,
  SnapshotAuthor,
  SnapshotStore,
} from './types.js'
import { clone, hashFiles, ulid } from './util.js'

const BUNDLE_KEY_PREFIX = 'v1:'
const WRITABLE_EXT = /\.(tsx|ts|jsx|js|css|json)$/

export class CommitRejectedError extends Error {
  constructor(
    readonly errors: CompileError[],
    readonly snapshot: Snapshot,
  ) {
    super(`Commit rejected: ${errors.map((e) => `${e.file}:${e.line}:${e.column} ${e.text}`).join('; ')}`)
    this.name = 'CommitRejectedError'
  }
}

export class ZoneViolationError extends Error {
  constructor(path: string) {
    super(`"${path}" is outside the dynamic zone and cannot be written`)
    this.name = 'ZoneViolationError'
  }
}

export interface Draft {
  message: string
  parentId: string | null
  files: FileMap
}

export interface EngineState {
  status: 'loading' | 'ready'
  head: Snapshot | null
  /** component id (`customer-card`) → module namespace */
  modules: Record<string, ModuleNamespace>
  /** Increments on every module swap; error boundaries reset on change. */
  version: number
  usingFallback: boolean
  draft: Draft | null
  canUndo: boolean
  canRedo: boolean
  error: string | null
  lastCheck: Omit<CompileResult, 'bundle'> | null
}

export interface EngineMetrics extends CompilerMetrics {
  lastCheckMs: number | null
  lastCommitMs: number | null
  /** Bundle evaluation + state swap, ms. */
  lastSwapMs: number | null
}

export interface CompilerLike {
  compile(files: FileMap): Promise<CompileResult>
  readonly metrics: CompilerMetrics
}

export interface EngineOptions {
  userId: string
  store: SnapshotStore
  config: MorphkitConfig
  compiler?: CompilerLike
  loader?: BundleLoader
}

/** `src/dynamic/customer-card.tsx` → `customer-card` */
export function componentId(path: string, roots: string[]): string {
  const root = roots.find((r) => path.startsWith(r)) ?? ''
  return path.slice(root.length).replace(/\.(tsx|ts|jsx|js|mts|mjs)$/, '')
}

/**
 * Framework-agnostic core: snapshots, draft → check → commit, undo/redo/reset and module swapping.
 * All state-changing operations run one at a time through an internal queue.
 */
export class MorphkitEngine {
  readonly userId: string
  private readonly store: SnapshotStore
  private readonly config: MorphkitConfig
  private readonly compiler: CompilerLike
  private readonly loader: BundleLoader
  private readonly baseFiles: FileMap
  private baseHash: Promise<string>
  private redoStack: string[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private listeners = new Set<() => void>()
  private timings = { lastCheckMs: null as number | null, lastCommitMs: null as number | null, lastSwapMs: null as number | null }
  private state: EngineState

  constructor(options: EngineOptions) {
    this.userId = options.userId
    this.store = options.store
    this.config = options.config
    this.compiler = options.compiler ?? new Compiler(options.config.manifest, { wasmURL: options.config.wasmURL })
    this.loader = options.loader ?? defaultLoader
    this.baseFiles = Object.fromEntries(options.config.manifest.dynamic.map((f) => [f.path, f.source]))
    this.baseHash = hashFiles(this.baseFiles)
    installExternals(options.config.externals)
    this.state = {
      status: 'loading',
      head: null,
      modules: this.fallbackModules(),
      version: 0,
      usingFallback: true,
      draft: null,
      canUndo: false,
      canRedo: false,
      error: null,
      lastCheck: null,
    }
  }

  // --- subscription (useSyncExternalStore) ---

  getState = (): EngineState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<EngineState>): void {
    const next = { ...this.state, ...patch }
    next.canUndo = Boolean(next.head?.parentId)
    next.canRedo = this.redoStack.length > 0
    this.state = next
    for (const l of this.listeners) l()
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op)
    this.queue = run.catch(() => undefined)
    return run
  }

  get metrics(): EngineMetrics {
    return { ...this.compiler.metrics, ...this.timings }
  }

  /** Files of the current head (or the base snapshot). */
  files(): FileMap {
    return clone(this.state.head?.files ?? this.baseFiles)
  }

  // --- lifecycle ---

  init(): Promise<void> {
    return this.enqueue(async () => {
      const head = await this.store.head(this.userId)
      if (!head) return this.set({ status: 'ready' })
      try {
        await this.activate(head)
        this.set({ status: 'ready', head })
      } catch (e) {
        this.set({ status: 'ready', head, error: `Could not load your version, showing the original: ${(e as Error).message}` })
      }
    })
  }

  private fallbackModules(): Record<string, ModuleNamespace> {
    const roots = this.config.manifest.dynamicRoots
    const out: Record<string, ModuleNamespace> = {}
    for (const [path, ns] of Object.entries(this.config.fallback)) out[componentId(path, roots)] = ns
    return out
  }

  private swap(modules: Record<string, ModuleNamespace>, css: string, usingFallback: boolean, head: Snapshot | null): void {
    const roots = this.config.manifest.dynamicRoots
    const byId: Record<string, ModuleNamespace> = {}
    for (const [path, ns] of Object.entries(modules)) byId[componentId(path, roots)] = ns
    applyCss(css)
    this.set({ modules: usingFallback ? modules : byId, usingFallback, version: this.state.version + 1, head, error: null })
  }

  private async loadBundle(bundle: CompiledBundle): Promise<Record<string, ModuleNamespace>> {
    const started = performance.now()
    const modules = await this.loader(bundle)
    this.timings.lastSwapMs = performance.now() - started
    return modules
  }

  /** Make the snapshot's modules live: base → fallback bundle, otherwise cached or freshly compiled bundle. */
  private async activate(snapshot: Snapshot): Promise<void> {
    const hash = await hashFiles(snapshot.files)
    if (hash === (await this.baseHash)) return this.swap(this.fallbackModules(), '', true, snapshot)
    const key = BUNDLE_KEY_PREFIX + hash
    let bundle = await this.store.bundleCache.get(key)
    if (!bundle) {
      const result = await this.compiler.compile(snapshot.files)
      if (!result.ok || !result.bundle) throw new CommitRejectedError(result.errors, snapshot)
      bundle = result.bundle
      await this.store.bundleCache.put(key, bundle)
    }
    this.swap(await this.loadBundle(bundle), bundle.css, false, snapshot)
  }

  private async ensureBase(): Promise<Snapshot> {
    const base: Snapshot = {
      id: ulid(),
      parentId: null,
      userId: this.userId,
      files: clone(this.baseFiles),
      message: 'Original version',
      author: 'base',
      createdAt: new Date().toISOString(),
      status: 'applied',
    }
    await this.store.put(base)
    return base
  }

  private async root(from: Snapshot): Promise<Snapshot> {
    let s = from
    while (s.parentId) s = await this.store.get(s.parentId)
    return s
  }

  // --- draft ---

  private isWritable(path: string): boolean {
    if (path.includes('..') || path.startsWith('/') || path.includes('\\')) return false
    if (!WRITABLE_EXT.test(path)) return false
    return this.config.manifest.dynamicRoots.some((r) => path.startsWith(r))
  }

  private requireDraft(): Draft {
    if (!this.state.draft) throw new Error('No draft: call draft.start() first')
    return this.state.draft
  }

  readonly draft = {
    /** Copy head into a fresh draft. */
    start: (message = ''): Draft => {
      const draft: Draft = { message, parentId: this.state.head?.id ?? null, files: this.files() }
      this.set({ draft })
      return draft
    },
    write: (path: string, source: string): void => {
      if (!this.isWritable(path)) throw new ZoneViolationError(path)
      const draft = this.requireDraft()
      this.set({ draft: { ...draft, files: { ...draft.files, [path]: source } } })
    },
    remove: (path: string): void => {
      if (!this.isWritable(path)) throw new ZoneViolationError(path)
      const draft = this.requireDraft()
      const files = { ...draft.files }
      delete files[path]
      this.set({ draft: { ...draft, files } })
    },
    read: (path: string): string | undefined => (this.state.draft?.files ?? this.files())[path],
    list: (): string[] => Object.keys(this.state.draft?.files ?? this.files()).sort(),
    files: (): FileMap => clone(this.state.draft?.files ?? this.files()),
    /** Compile the draft without applying it. */
    check: async (): Promise<CompileResult> => {
      const result = await this.compiler.compile(this.requireDraft().files)
      this.timings.lastCheckMs = result.timeMs
      this.set({ lastCheck: { ...result, bundle: undefined } })
      return result
    },
    /** check + store + set head + swap. Throws CommitRejectedError if the draft does not compile or evaluate. */
    commit: (author: SnapshotAuthor = 'user'): Promise<Snapshot> => this.enqueue(() => this.commit(author)),
    discard: (): void => this.set({ draft: null }),
  }

  private async commit(author: SnapshotAuthor): Promise<Snapshot> {
    const draft = this.requireDraft()
    const started = performance.now()
    const result = await this.compiler.compile(draft.files)
    this.timings.lastCheckMs = result.timeMs
    const parentId = draft.parentId ?? (await this.ensureBase()).id
    const snapshot: Snapshot = {
      id: ulid(),
      parentId,
      userId: this.userId,
      files: clone(draft.files),
      message: draft.message,
      author,
      createdAt: new Date().toISOString(),
      status: 'applied',
    }
    const reject = async (errors: CompileError[]): Promise<never> => {
      snapshot.status = 'rejected'
      await this.store.put(snapshot)
      this.set({ lastCheck: { ...result, ok: false, errors, bundle: undefined } })
      throw new CommitRejectedError(errors, snapshot)
    }
    if (!result.ok || !result.bundle) return reject(result.errors)

    let modules: Record<string, ModuleNamespace>
    try {
      modules = await this.loadBundle(result.bundle)
    } catch (e) {
      return reject([{ file: '', line: 0, column: 0, text: `Module failed to evaluate: ${(e as Error).message}` }])
    }
    await this.store.put(snapshot)
    await this.store.bundleCache.put(BUNDLE_KEY_PREFIX + result.hash, result.bundle)
    await this.store.setHead(this.userId, snapshot.id)
    this.redoStack = []
    this.set({ draft: null, lastCheck: { ...result, bundle: undefined } })
    this.swap(modules, result.bundle.css, false, snapshot)
    this.timings.lastCommitMs = performance.now() - started
    return snapshot
  }

  // --- navigation ---

  private async moveHead(target: Snapshot): Promise<Snapshot> {
    await this.activate(target)
    await this.store.setHead(this.userId, target.id)
    this.set({ head: target })
    return target
  }

  /** head = head.parent. Returns the new head, or null if there is nothing to undo. */
  undo(): Promise<Snapshot | null> {
    return this.enqueue(async () => {
      const head = this.state.head
      if (!head?.parentId) return null
      const parent = await this.store.get(head.parentId)
      await this.moveHead(parent)
      this.redoStack.push(head.id)
      this.set({})
      return parent
    })
  }

  redo(): Promise<Snapshot | null> {
    return this.enqueue(async () => {
      const id = this.redoStack.pop()
      if (!id) return null
      return this.moveHead(await this.store.get(id))
    })
  }

  /** Back to the original version; redo returns to where you were. */
  reset(): Promise<Snapshot | null> {
    return this.enqueue(async () => {
      const head = this.state.head
      if (!head || !head.parentId) return head
      const base = await this.root(head)
      await this.moveHead(base)
      this.redoStack.push(head.id)
      this.set({})
      return base
    })
  }

  /** Undo only if `snapshotId` is still the head (used by error boundaries; safe to call repeatedly). */
  rollback(snapshotId: string): Promise<Snapshot | null> {
    if (this.state.head?.id !== snapshotId) return Promise.resolve(null)
    return this.undo().then((s) => {
      this.redoStack = this.redoStack.filter((id) => id !== snapshotId)
      this.set({})
      return s
    })
  }

  history(limit?: number): Promise<Snapshot[]> {
    return this.store.list(this.userId, limit)
  }

  /** Paths of component modules in the dynamic zone, by id. */
  componentIds(): string[] {
    return Object.keys(this.files())
      .filter(isScript)
      .map((p) => componentId(p, this.config.manifest.dynamicRoots))
  }
}
