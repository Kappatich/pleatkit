import { Compiler, isScript, type CompilerMetrics } from './compiler.js'
import { CssCompiler, type CssMetrics } from './css.js'
import { applyCss, defaultLoader, installExternals, type BundleLoader } from './loader.js'
import type { AgentRunRequest } from './protocol.js'
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

// v2: bundles carry Tailwind CSS; the CSS mode is part of the key so switching modes never reuses stale CSS.
const BUNDLE_KEY_VERSION = 'v2'
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
  /** The head was made against an older release of the app (its `baseHash` differs from the current base). */
  stale: boolean
}

export interface EngineMetrics extends CompilerMetrics, CssMetrics {
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
  cssCompiler?: CssCompiler
}

export interface CommitOptions {
  /** Agent request id, linked to the snapshot (and reported to the store's request log). */
  requestId?: string
}

function summarize({ bundle: _bundle, ...rest }: CompileResult): Omit<CompileResult, 'bundle'> {
  return rest
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
  private readonly css: CssCompiler
  private readonly baseFiles: FileMap
  private readonly baseHash: Promise<string>
  private readonly mounted = new Map<string, number>()
  private bundle: CompiledBundle | null = null
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
    this.css = options.cssCompiler ?? new CssCompiler(options.config.css)
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
      stale: false,
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
    return { ...this.compiler.metrics, ...this.css.metrics, ...this.timings }
  }

  /** `tailwind` when edits get runtime-compiled Tailwind CSS, `palette` otherwise. */
  get cssMode(): 'tailwind' | 'palette' {
    return this.css.mode
  }

  /** Hash of the app's current base snapshot. */
  currentBaseHash(): Promise<string> {
    return this.baseHash
  }

  private bundleKey(hash: string): string {
    return `${BUNDLE_KEY_VERSION}:${this.css.mode}:${hash}`
  }

  /**
   * Preload the compilers (esbuild-wasm and, in `tailwind` mode, the Tailwind compiler) so the first commit
   * does not pay for them. Called by the chat UI when it opens. Safe to call repeatedly.
   */
  async warmup(): Promise<EngineMetrics> {
    const compiler = this.compiler as CompilerLike & { init?: () => Promise<unknown> }
    await Promise.all([compiler.init?.(), this.css.init()])
    return this.metrics
  }

  /** Called by `<Dynamic id>` while mounted. Mounted panels must keep a default export (DECISIONS item 5). */
  mount(id: string): () => void {
    this.mounted.set(id, (this.mounted.get(id) ?? 0) + 1)
    return () => {
      const n = (this.mounted.get(id) ?? 1) - 1
      if (n <= 0) this.mounted.delete(id)
      else this.mounted.set(id, n)
    }
  }

  /**
   * Dynamic files that must export a default component: every file mounted through `<Dynamic id>` right now,
   * plus every file whose original version has a default export (panels that are not on screen at the moment).
   */
  requiredComponents(files: FileMap = this.files()): string[] {
    const roots = this.config.manifest.dynamicRoots
    const paths = new Set<string>()
    for (const [path, ns] of Object.entries(this.config.fallback)) if (ns && 'default' in ns) paths.add(path)
    for (const path of Object.keys(files)) if (isScript(path) && this.mounted.has(componentId(path, roots))) paths.add(path)
    return [...paths].sort()
  }

  /** Everything the agent server needs for one run, from the current head (or draft). */
  agentRequest(request: string, extra: Partial<AgentRunRequest> = {}): AgentRunRequest {
    const m = this.config.manifest
    const files = this.draft.files()
    return {
      userId: this.userId,
      request,
      files,
      readonly: Object.fromEntries(m.readonly.map((f) => [f.path, f.source])),
      coreTypes: Object.fromEntries(m.coreTypes.map((f) => [f.path, f.source])),
      context: { alias: m.alias, externals: m.externals, externalPatterns: m.externalPatterns, dynamicRoots: m.dynamicRoots },
      components: this.requiredComponents(files),
      ...extra,
    }
  }

  /** The base files the stale head was made from, and the head's files: input for an agent migration. */
  async migrationInput(): Promise<AgentRunRequest['migration'] | null> {
    const head = this.state.head
    if (!head || !this.state.stale) return null
    const root = await this.root(head)
    return { oldBase: clone(root.files), edited: clone(head.files) }
  }

  /** Files of the current head (or the base snapshot). */
  files(): FileMap {
    return clone(this.state.head?.files ?? this.baseFiles)
  }

  // --- lifecycle ---

  private initPromise: Promise<void> | null = null

  /** Load the user's head. Idempotent. */
  init(): Promise<void> {
    return (this.initPromise ??= this.enqueue(() => this.loadHead()))
  }

  private async loadHead(): Promise<void> {
    const head = await this.store.head(this.userId)
    if (!head) {
      if (this.state.head) this.swap(this.fallbackModules(), null, true, null)
      return this.set({ status: 'ready', head: null, stale: false })
    }
    const stale = await this.isStale(head)
    if (head.id === this.state.head?.id) return this.set({ status: 'ready', stale })
    try {
      await this.activate(head)
      this.set({ status: 'ready', head, stale })
    } catch (e) {
      this.set({ status: 'ready', head, stale, error: `Could not load your version, showing the original: ${(e as Error).message}` })
    }
  }

  /**
   * Re-read the head from the store, e.g. after an admin rolled the user back on the server.
   * Does nothing while a draft is open.
   */
  refresh(): Promise<void> {
    return this.enqueue(async () => {
      if (this.state.draft) return
      await this.loadHead()
    })
  }

  private async isStale(head: Snapshot): Promise<boolean> {
    return Boolean(head.baseHash) && head.baseHash !== (await this.baseHash)
  }

  private fallbackModules(): Record<string, ModuleNamespace> {
    const roots = this.config.manifest.dynamicRoots
    const out: Record<string, ModuleNamespace> = {}
    for (const [path, ns] of Object.entries(this.config.fallback)) out[componentId(path, roots)] = ns
    return out
  }

  /** Loader of the iframe host script for `isolated` panels, when the Vite plugin provides one. */
  isolatedLoader(): (() => Promise<string>) | null {
    return this.config.isolated?.load ?? null
  }

  /** Compiled bundle of the live modules; null while the original (fallback) version is shown. */
  currentBundle(): CompiledBundle | null {
    return this.bundle
  }

  private swap(modules: Record<string, ModuleNamespace>, bundle: CompiledBundle | null, usingFallback: boolean, head: Snapshot | null): void {
    const roots = this.config.manifest.dynamicRoots
    const css = bundle?.css ?? ''
    this.bundle = usingFallback ? null : bundle
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
    if (hash === (await this.baseHash)) return this.swap(this.fallbackModules(), null, true, snapshot)
    const key = this.bundleKey(hash)
    let bundle = await this.store.bundleCache.get(key)
    if (!bundle) {
      const result = await this.compiler.compile(snapshot.files)
      if (!result.ok || !result.bundle) throw new CommitRejectedError(result.errors, snapshot)
      bundle = await this.withCss(result.bundle, snapshot.files)
      await this.store.bundleCache.put(key, bundle)
    }
    this.swap(await this.loadBundle(bundle), bundle, false, snapshot)
  }

  /** esbuild's CSS (from `.css` files in the zone) followed by the Tailwind utilities the zone uses. */
  private async withCss(bundle: CompiledBundle, files: FileMap): Promise<CompiledBundle> {
    const tailwind = await this.css.build(files)
    return { js: bundle.js, css: [bundle.css, tailwind].filter(Boolean).join('\n') }
  }

  /** Default-export check for panels, on the evaluated modules, before the head moves. */
  private missingDefaults(modules: Record<string, ModuleNamespace>, files: FileMap): CompileError[] {
    return this.requiredComponents(files)
      .filter((path) => {
        const d = modules[path]?.default
        return !(typeof d === 'function' || (typeof d === 'object' && d !== null))
      })
      .map((path) => ({
        file: path,
        line: 0,
        column: 0,
        text: path in files ? `no default export in ${path}` : `${path} was removed, but a <Dynamic> panel needs it`,
      }))
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
      baseHash: await this.baseHash,
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
      this.set({ lastCheck: summarize(result) })
      return result
    },
    /** check + store + set head + swap. Throws CommitRejectedError if the draft does not compile or evaluate. */
    commit: (author: SnapshotAuthor = 'user', options: CommitOptions = {}): Promise<Snapshot> => this.enqueue(() => this.commit(author, options)),
    discard: (): void => this.set({ draft: null }),
  }

  private async commit(author: SnapshotAuthor, options: CommitOptions): Promise<Snapshot> {
    const draft = this.requireDraft()
    const started = performance.now()
    const result = await this.compiler.compile(draft.files)
    this.timings.lastCheckMs = result.timeMs
    const parentId = draft.parentId ?? (await this.ensureBase()).id
    // Every new snapshot is made against today's release, also when its parent is stale (a migration).
    const baseHash = await this.baseHash
    const snapshot: Snapshot = {
      id: ulid(),
      parentId,
      userId: this.userId,
      files: clone(draft.files),
      message: draft.message,
      author,
      createdAt: new Date().toISOString(),
      status: 'applied',
      baseHash,
      ...(options.requestId ? { requestId: options.requestId } : {}),
    }
    const reject = async (errors: CompileError[]): Promise<never> => {
      snapshot.status = 'rejected'
      await this.store.put(snapshot)
      this.set({ lastCheck: { ...summarize(result), ok: false, errors } })
      throw new CommitRejectedError(errors, snapshot)
    }
    if (!result.ok || !result.bundle) return reject(result.errors)

    let modules: Record<string, ModuleNamespace>
    try {
      modules = await this.loadBundle(result.bundle)
    } catch (e) {
      return reject([{ file: '', line: 0, column: 0, text: `Module failed to evaluate: ${(e as Error).message}` }])
    }
    const missing = this.missingDefaults(modules, draft.files)
    if (missing.length > 0) return reject(missing)
    let bundle: CompiledBundle
    try {
      bundle = await this.withCss(result.bundle, draft.files)
    } catch (e) {
      return reject([{ file: '', line: 0, column: 0, text: `CSS generation failed: ${(e as Error).message}` }])
    }
    await this.store.put(snapshot)
    await this.store.bundleCache.put(this.bundleKey(result.hash), bundle)
    await this.store.setHead(this.userId, snapshot.id)
    this.redoStack = []
    this.set({ draft: null, lastCheck: summarize(result), stale: false })
    this.swap(modules, bundle, false, snapshot)
    this.timings.lastCommitMs = performance.now() - started
    return snapshot
  }

  // --- navigation ---

  private async moveHead(target: Snapshot): Promise<Snapshot> {
    await this.activate(target)
    await this.store.setHead(this.userId, target.id)
    this.set({ head: target, stale: await this.isStale(target) })
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

  /**
   * Back to the original version; redo returns to where you were. When the head is stale (made against an
   * older release), "original" means the current release, so a fresh base snapshot is written.
   */
  reset(): Promise<Snapshot | null> {
    return this.enqueue(async () => {
      const head = this.state.head
      if (!head) return head
      if (this.state.stale) {
        const fresh = await this.ensureBase()
        await this.moveHead(fresh)
        this.redoStack = []
        this.set({})
        return fresh
      }
      if (!head.parentId) return head
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
