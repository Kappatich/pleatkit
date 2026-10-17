import { Compiler, isScript, type CompilerMetrics } from './compiler.js'
import { CssCompiler, type CssMetrics } from './css.js'
import { applyCss, defaultLoader, installExternals, type BundleLoader } from './loader.js'
import type { AgentRunRequest } from './protocol.js'
import { browserBootStorage, HEARTBEAT_MS, PAGE_ID, previousLoadFailed, readBoot, safeModeRequested, writeBoot, type BootStorage } from './safe-mode.js'
import { sha256Hex } from './security.js'
import { bundleKey, contextHash, ServerBundles, type ServerBundlesOptions } from './server-bundles.js'
import type {
  CompileError,
  CompileMode,
  CompileResult,
  CompiledBundle,
  FileMap,
  ModuleNamespace,
  MorphkitConfig,
  RequestLinkPatch,
  RequestLinkResult,
  Snapshot,
  SnapshotAuthor,
  SnapshotStore,
} from './types.js'
import { clone, hashFiles, ulid } from './util.js'

const WRITABLE_EXT = /\.(tsx|ts|jsx|js|css|json)$/
/** Version of the Snapshot shape written by this runtime (F4). 2: `baseFiles`, `schemaVersion`. */
export const SNAPSHOT_SCHEMA_VERSION = 2

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

/** Why the original version is shown although the user has their own (V1 B2). */
export interface SafeModeState {
  /** `crash`: the last load of this version did not mount; `param`: `?morphkit=safe`. */
  reason: 'crash' | 'param'
  snapshotId: string
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
  /** The head was made against an older release of the app and could not be carried over by itself. */
  stale: boolean
  /** Panels (component ids) both the user and the new release changed (V1 B5); empty when not stale. */
  stalePanels: string[]
  /** Set while the original version is shown instead of the user's (V1 B2). */
  safeMode: SafeModeState | null
  /** Where edits are compiled right now (`browser` may have fallen back to `server`). */
  compileMode: CompileMode
}

export interface EngineMetrics extends CompilerMetrics, CssMetrics {
  lastCheckMs: number | null
  lastCommitMs: number | null
  /** Bundle evaluation + state swap, ms. */
  lastSwapMs: number | null
  /** Server compile round trip of the last commit (compile: 'server'), ms. */
  lastServerCompileMs: number | null
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
  /** App instance namespace (V1 B6). Default: the store's `appId` (HttpStore), else `default`. */
  namespace?: string
  /** Overrides `config.compile`. A configured public key always means `server`. */
  compile?: CompileMode
  /** Agent server for server compiles. Default `/agent`. */
  agentUrl?: string
  /** Same-origin URL of signed bundles. Default `/morphkit/b`. */
  bundleUrl?: string
  /** Overrides `config.publicKey`. */
  publicKey?: string | null
  /** User token for server compiles (production). */
  token?: ServerBundlesOptions['token']
  /** Server-compile client (tests inject one). */
  serverBundles?: ServerBundles
  /** In browser mode, compile on the server when esbuild-wasm cannot load (default true when an agent URL is known). */
  autoFallback?: boolean
  /** Where boot records for safe mode live (default localStorage). */
  bootStorage?: BootStorage | null
  /** Start in safe mode (default: `?morphkit=safe` in the URL). */
  safeMode?: boolean
  heartbeatMs?: number
  /** Id of this page load (tests simulate a reload with another one). */
  pageId?: string
}

export interface CommitOptions {
  /** Agent request id, linked to the snapshot (and reported to the store's request log). */
  requestId?: string
  /** A bundle the agent server already compiled for these files (compile: 'server'), saving a round trip. */
  bundle?: { key: string; filesHash: string }
}

function summarize({ bundle: _bundle, ...rest }: CompileResult): Omit<CompileResult, 'bundle'> {
  return rest
}

/** `src/dynamic/customer-card.tsx` → `customer-card` */
export function componentId(path: string, roots: string[]): string {
  const root = roots.find((r) => path.startsWith(r)) ?? ''
  return path.slice(root.length).replace(/\.(tsx|ts|jsx|js|mts|mjs)$/, '')
}

/** sha256 per file: what the per-file `baseHash` of a snapshot is made of (V1 B5). */
export async function fileHashes(files: FileMap): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [p, s] of Object.entries(files)) out[p] = (await sha256Hex(s)).slice(0, 32)
  return out
}

/** Paths whose hash differs between two per-file hash maps, including added and removed files. */
export function changedPaths(a: Record<string, string>, b: Record<string, string>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((p) => a[p] !== b[p]).sort()
}

/**
 * Framework-agnostic core: snapshots, draft → check → commit, undo/redo/reset and module swapping.
 * All state-changing operations run one at a time through an internal queue.
 */
export class MorphkitEngine {
  readonly userId: string
  /** App instance namespace (V1 B6): its own externals registry, stylesheet and boot record. */
  readonly namespace: string
  private readonly store: SnapshotStore
  private readonly config: MorphkitConfig
  private readonly compiler: CompilerLike
  private readonly loader: BundleLoader
  private readonly css: CssCompiler
  private readonly baseFiles: FileMap
  private readonly baseHash: Promise<string>
  private readonly baseFileHashes: Promise<Record<string, string>>
  private readonly ctxHash: Promise<string>
  private readonly server: ServerBundles | null
  private readonly autoFallback: boolean
  private readonly registry: ReturnType<typeof installExternals>
  private readonly boot: BootStorage | null
  private readonly bootKey: string
  private readonly heartbeatMs: number
  private readonly forceSafe: boolean
  private readonly pageId: string
  private heartbeat: ReturnType<typeof setTimeout> | null = null
  private mode: CompileMode
  private readonly mounted = new Map<string, number>()
  private bundle: CompiledBundle | null = null
  private bundleId: string | null = null
  private redoStack: string[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private listeners = new Set<() => void>()
  private timings = { lastCheckMs: null as number | null, lastCommitMs: null as number | null, lastSwapMs: null as number | null, lastServerCompileMs: null as number | null }
  private state: EngineState

  constructor(options: EngineOptions) {
    this.userId = options.userId
    this.store = options.store
    this.config = options.config
    this.namespace = options.namespace ?? (options.store as { appId?: string }).appId ?? 'default'
    const publicKey = options.publicKey !== undefined ? options.publicKey : (options.config.publicKey ?? null)
    // a public key means only signed bundles run, and only the server can sign
    this.mode = publicKey ? 'server' : (options.compile ?? options.config.compile ?? 'browser')
    const agentUrl = options.agentUrl ?? '/agent'
    this.server =
      options.serverBundles ??
      new ServerBundles({ agentUrl, bundleUrl: options.bundleUrl ?? '/morphkit/b', namespace: this.namespace, publicKey, ...(options.token ? { token: options.token } : {}) })
    this.autoFallback = options.autoFallback ?? true
    const m = options.config.manifest
    this.compiler = options.compiler ?? new Compiler({ ...m, namespace: this.namespace }, { wasmURL: options.config.wasmURL })
    this.loader = options.loader ?? defaultLoader
    this.css = options.cssCompiler ?? new CssCompiler(options.config.css)
    this.baseFiles = Object.fromEntries(m.dynamic.map((f) => [f.path, f.source]))
    this.baseHash = hashFiles(this.baseFiles)
    this.baseFileHashes = fileHashes(this.baseFiles)
    this.ctxHash = contextHash(m, Object.fromEntries(m.readonly.map((f) => [f.path, f.source])))
    this.registry = installExternals(options.config.externals, this.namespace)
    this.boot = options.bootStorage !== undefined ? options.bootStorage : browserBootStorage()
    this.bootKey = `morphkit:boot:${this.namespace}:${this.userId}`
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
    this.forceSafe = options.safeMode ?? safeModeRequested()
    this.pageId = options.pageId ?? PAGE_ID
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      // leaving on purpose before the version mounted is not a crash
      window.addEventListener('pagehide', () => {
        const rec = readBoot(this.boot, this.bootKey)
        if (rec && !rec.mounted && rec.closedAt === undefined) writeBoot(this.boot, this.bootKey, { ...rec, closedAt: Date.now() })
      })
    }
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
      stalePanels: [],
      safeMode: null,
      compileMode: this.mode,
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

  /** Where edits are compiled right now. */
  get compileMode(): CompileMode {
    return this.mode
  }

  /** Hash of the app's current base snapshot. */
  currentBaseHash(): Promise<string> {
    return this.baseHash
  }

  /**
   * Tags for error reporting (V1 B7), e.g. `Sentry.setTags(engine.tags())`: which personal version and bundle
   * were live. Stack frames of edits read `morphkit://<bundle>/bundle.js`.
   */
  tags(): Record<string, string> {
    const head = this.state.head
    return {
      'morphkit.app': this.namespace,
      'morphkit.snapshotId': head && !this.state.usingFallback ? head.id : 'base',
      'morphkit.bundle': this.bundleId ?? 'base',
      'morphkit.compile': this.mode,
      ...(this.state.safeMode ? { 'morphkit.safeMode': this.state.safeMode.reason } : {}),
    }
  }

  private async key(filesHash: string): Promise<string> {
    return bundleKey({ namespace: this.namespace, filesHash, contextHash: await this.ctxHash, cssMode: this.css.mode })
  }

  /**
   * Preload the compilers (esbuild-wasm and, in `tailwind` mode, the Tailwind compiler) so the first commit
   * does not pay for them. Called by the chat UI when it opens. Safe to call repeatedly. Nothing to load in
   * server mode.
   */
  async warmup(): Promise<EngineMetrics> {
    if (this.mode === 'server') return this.metrics
    this.warming ??= (async () => {
      const compiler = this.compiler as CompilerLike & { init?: () => Promise<unknown> }
      try {
        await Promise.all([compiler.init?.(), this.css.init()])
      } catch (e) {
        if (this.fallBackToServer(e)) return
        throw e
      }
      // One throwaway build: the first compile after init is several times slower while V8 tiers up the
      // wasm code. Doing it while the user types makes the first real commit as fast as later ones.
      const files = this.files()
      await Promise.all([this.compiler.compile(files).catch(() => null), this.css.build(files).catch(() => '')])
    })()
    this.warming.catch(() => {
      this.warming = null
    })
    await this.warming
    return this.metrics
  }

  private warming: Promise<void> | null = null

  /** esbuild-wasm could not load (CSP without 'wasm-unsafe-eval', a proxy blocking .wasm, iOS memory): use the server. */
  private fallBackToServer(e: unknown): boolean {
    if (this.mode !== 'browser' || !this.autoFallback || !this.server) return false
    console.warn('[morphkit] the in-browser compiler could not load; compiling edits on the agent server instead', e)
    this.mode = 'server'
    this.set({ compileMode: 'server' })
    return true
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
      appId: this.namespace,
      request,
      files,
      readonly: Object.fromEntries(m.readonly.map((f) => [f.path, f.source])),
      coreTypes: Object.fromEntries(m.coreTypes.map((f) => [f.path, f.source])),
      context: {
        alias: m.alias,
        externals: m.externals,
        externalPatterns: m.externalPatterns,
        dynamicRoots: m.dynamicRoots,
        namespace: this.namespace,
        ...(m.css ? { css: m.css } : {}),
      },
      components: this.requiredComponents(files),
      // the agent server compiles and signs the result too, so the commit is a download (V1 B1)
      ...(this.mode === 'server' ? { compile: true } : {}),
      ...extra,
    }
  }

  /**
   * The base files the stale head was made from, and the head's files: input for an agent migration.
   * Send it with `files: originalFiles()` and start the draft from `originalFiles()` too.
   */
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

  /** The current release's original dynamic files (the manifest's base snapshot). */
  originalFiles(): FileMap {
    return clone(this.baseFiles)
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
      return this.set({ status: 'ready', head: null, stale: false, stalePanels: [] })
    }
    const stale = await this.isStale(head)
    if (head.id === this.state.head?.id && !this.state.safeMode) return this.set({ status: 'ready', stale })
    // V1 B2: the last load of this version never mounted (or the user asked): show the original instead
    if (head.parentId && (this.forceSafe || previousLoadFailed(readBoot(this.boot, this.bootKey), head.id, this.pageId))) {
      this.swap(this.fallbackModules(), null, true, head)
      return this.set({ status: 'ready', head, stale, safeMode: { reason: this.forceSafe ? 'param' : 'crash', snapshotId: head.id } })
    }
    let stalePanels: string[] = []
    if (stale) {
      // V1 B5: carry the edits over by themselves when the release did not touch the files the user changed
      const carried = await this.carryOver(head)
      if (carried === true) return this.set({ status: 'ready' })
      stalePanels = carried
    }
    try {
      await this.activate(head)
      this.set({ status: 'ready', head, stale, stalePanels, safeMode: null })
    } catch (e) {
      this.set({ status: 'ready', head, stale, stalePanels, error: `Could not load your version, showing the original: ${(e as Error).message}` })
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

  /** Leave safe mode: load the user's own version again (the banner's "Try my version again"). */
  leaveSafeMode(): Promise<void> {
    return this.enqueue(async () => {
      const head = this.state.head
      if (!this.state.safeMode || !head) return
      writeBoot(this.boot, this.bootKey, null)
      try {
        await this.activate(head)
        this.set({ safeMode: null })
      } catch (e) {
        this.set({ error: `Could not load your version, showing the original: ${(e as Error).message}` })
      }
    })
  }

  private async isStale(head: Snapshot): Promise<boolean> {
    return Boolean(head.baseHash) && head.baseHash !== (await this.baseHash)
  }

  /**
   * V1 B5. Per-file comparison of the release the head was made on and today's: when no file the user changed
   * was changed by the release, the user's files are laid over the new base and committed as a new snapshot
   * (true). Otherwise returns the panels that need a decision (the stale banner, per panel).
   */
  private async carryOver(head: Snapshot): Promise<true | string[]> {
    const root = await this.root(head)
    const oldBase = head.baseFiles ?? (await fileHashes(root.files))
    const newBase = await this.baseFileHashes
    const released = changedPaths(oldBase, newBase)
    const touched = changedPaths(oldBase, await fileHashes(head.files))
    const conflicts = released.filter((p) => touched.includes(p))
    const roots = this.config.manifest.dynamicRoots
    if (conflicts.length > 0) return [...new Set(conflicts.filter(isScript).map((p) => componentId(p, roots)))]
    const files = clone(this.baseFiles)
    for (const p of touched) {
      if (p in head.files) files[p] = head.files[p]!
      else delete files[p]
    }
    try {
      await this.commitFiles(files, 'Carried over to the new version of the app', head.id, 'user', {})
      return true
    } catch {
      // it does not compile on the new release: the user decides (reset or ask the agent)
      return [...new Set(touched.filter(isScript).map((p) => componentId(p, roots)))]
    }
  }

  private fallbackModules(): Record<string, ModuleNamespace> {
    const roots = this.config.manifest.dynamicRoots
    const out: Record<string, ModuleNamespace> = {}
    for (const [path, ns] of Object.entries(this.config.fallback)) out[componentId(path, roots)] = ns
    return out
  }

  /** URL of the iframe host script for `isolated` panels, when the Vite plugin provides one. */
  isolatedHostUrl(): string | null {
    return this.config.isolated?.url ?? null
  }

  /** Compiled bundle of the live modules; null while the original (fallback) version is shown. */
  currentBundle(): CompiledBundle | null {
    return this.bundle
  }

  private swap(modules: Record<string, ModuleNamespace>, bundle: CompiledBundle | null, usingFallback: boolean, head: Snapshot | null, bundleId: string | null = null): void {
    const roots = this.config.manifest.dynamicRoots
    const css = bundle?.css ?? ''
    this.bundle = usingFallback ? null : bundle
    this.bundleId = usingFallback ? null : bundleId
    const byId: Record<string, ModuleNamespace> = {}
    for (const [path, ns] of Object.entries(modules)) byId[componentId(path, roots)] = ns
    // V1 B4: panels capture their inputs and scroll before the swap and restore them after it
    for (const l of this.swapListeners) l()
    applyCss(css, this.namespace)
    this.set({ modules: usingFallback ? modules : byId, usingFallback, version: this.state.version + 1, head, error: null })
  }

  private swapListeners = new Set<() => void>()

  /** Called synchronously right before modules are swapped (state preservation, V1 B4). */
  onBeforeSwap(listener: () => void): () => void {
    this.swapListeners.add(listener)
    return () => this.swapListeners.delete(listener)
  }

  private async loadBundle(bundle: CompiledBundle): Promise<Record<string, ModuleNamespace>> {
    const started = performance.now()
    await this.registry.ensure(bundle.externals)
    const modules = await this.loader(bundle)
    this.timings.lastSwapMs = performance.now() - started
    return modules
  }

  // --- safe mode heartbeat (V1 B2) ---

  private beginBoot(snapshotId: string): void {
    writeBoot(this.boot, this.bootKey, { snapshotId, at: Date.now(), mounted: false, page: this.pageId })
    if (this.heartbeat) clearTimeout(this.heartbeat)
    // fires only if the page stays responsive after the swap: a render or effect that loops forever blocks it
    this.heartbeat = setTimeout(() => {
      this.heartbeat = null
      const rec = readBoot(this.boot, this.bootKey)
      if (rec?.snapshotId === snapshotId) writeBoot(this.boot, this.bootKey, { ...rec, mounted: true })
    }, this.heartbeatMs)
  }

  private endBoot(): void {
    if (this.heartbeat) clearTimeout(this.heartbeat)
    this.heartbeat = null
    writeBoot(this.boot, this.bootKey, null)
  }

  /** The bundle of these files: server mode loads (or has the agent server compile) a signed one; browser mode compiles here. */
  private async bundleFor(files: FileMap, filesHash: string, snapshot: Snapshot): Promise<{ bundle: CompiledBundle; key: string }> {
    const key = await this.key(filesHash)
    if (this.mode === 'server') {
      let bundle = await this.server!.load(key, filesHash)
      if (!bundle) {
        const r = await this.server!.compile({ userId: this.userId, files, readonly: this.readonlySources(), manifest: this.config.manifest, components: this.requiredComponents(files) })
        if (!r.ok || !r.key) throw new CommitRejectedError(r.errors, snapshot)
        bundle = await this.server!.load(r.key, filesHash)
        if (!bundle) throw new Error('the agent server compiled the bundle but it is not available under the bundle URL')
      }
      return { bundle, key }
    }
    let bundle = await this.store.bundleCache.get(key)
    if (!bundle) {
      let result: CompileResult
      try {
        result = await this.compiler.compile(files)
      } catch (e) {
        if (this.fallBackToServer(e)) return this.bundleFor(files, filesHash, snapshot)
        throw e
      }
      if (!result.ok || !result.bundle) throw new CommitRejectedError(result.errors, snapshot)
      bundle = await this.withCss(result.bundle, files)
      await this.store.bundleCache.put(key, bundle).catch(() => undefined)
    }
    return { bundle, key }
  }

  private readonlySources(): FileMap {
    return Object.fromEntries(this.config.manifest.readonly.map((f) => [f.path, f.source]))
  }

  /** Make the snapshot's modules live: base → fallback bundle, otherwise a cached, loaded or freshly compiled bundle. */
  private async activate(snapshot: Snapshot): Promise<void> {
    const hash = await hashFiles(snapshot.files)
    if (hash === (await this.baseHash)) {
      this.endBoot()
      return this.swap(this.fallbackModules(), null, true, snapshot)
    }
    const { bundle, key } = await this.bundleFor(snapshot.files, hash, snapshot)
    const modules = await this.loadBundle(bundle)
    this.beginBoot(snapshot.id)
    this.swap(modules, bundle, false, snapshot, key)
  }

  /** esbuild's CSS (from `.css` files in the zone) followed by the Tailwind utilities the zone uses. */
  private async withCss(bundle: CompiledBundle, files: FileMap): Promise<CompiledBundle> {
    const tailwind = await this.css.build(files)
    return { ...bundle, css: [bundle.css, tailwind].filter(Boolean).join('\n') }
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
      baseFiles: await this.baseFileHashes,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
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
    /**
     * Copy head into a fresh draft. `from` starts from other files instead (a migration starts from the
     * current release's base files); the parent is still the head, so undo returns to it.
     */
    start: (message = '', from?: FileMap): Draft => {
      const draft: Draft = { message, parentId: this.state.head?.id ?? null, files: from ? clone(from) : this.files() }
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
    /** Compile the draft without applying it (on the agent server in server mode, with its static rules). */
    check: async (): Promise<CompileResult> => {
      const files = this.requireDraft().files
      const result = await this.checkFiles(files)
      this.timings.lastCheckMs = result.timeMs
      this.set({ lastCheck: summarize(result) })
      return result
    },
    /** check + store + set head + swap. Throws CommitRejectedError if the draft does not compile or evaluate. */
    commit: (author: SnapshotAuthor = 'user', options: CommitOptions = {}): Promise<Snapshot> =>
      this.enqueue(async () => {
        const draft = this.requireDraft()
        const snapshot = await this.commitFiles(draft.files, draft.message, draft.parentId, author, options)
        this.set({ draft: null })
        return snapshot
      }),
    discard: (): void => this.set({ draft: null }),
  }

  private async checkFiles(files: FileMap): Promise<CompileResult> {
    const hash = await hashFiles(files)
    if (this.mode === 'server') {
      const r = await this.server!.compile({ userId: this.userId, files, readonly: this.readonlySources(), manifest: this.config.manifest, components: this.requiredComponents(files), check: true })
      return { ok: r.ok, errors: r.errors, warnings: [], hash, timeMs: r.timeMs }
    }
    try {
      return await this.compiler.compile(files)
    } catch (e) {
      if (this.fallBackToServer(e)) return this.checkFiles(files)
      throw e
    }
  }

  /** The commit itself: compile (here or on the server), evaluate, check exports, store, move the head, swap. */
  private async commitFiles(files: FileMap, message: string, draftParent: string | null, author: SnapshotAuthor, options: CommitOptions): Promise<Snapshot> {
    const started = performance.now()
    const filesHash = await hashFiles(files)
    const parentId = draftParent ?? (await this.ensureBase()).id
    // Every new snapshot is made against today's release, also when its parent is stale (a migration).
    const snapshot: Snapshot = {
      id: ulid(),
      parentId,
      userId: this.userId,
      files: clone(files),
      message,
      author,
      createdAt: new Date().toISOString(),
      status: 'applied',
      baseHash: await this.baseHash,
      baseFiles: await this.baseFileHashes,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      ...(options.requestId ? { requestId: options.requestId } : {}),
    }
    let lastCheck: Omit<CompileResult, 'bundle'> = { ok: true, errors: [], warnings: [], hash: filesHash, timeMs: 0 }
    const reject = async (errors: CompileError[]): Promise<never> => {
      snapshot.status = 'rejected'
      await this.store.put(snapshot)
      this.set({ lastCheck: { ...lastCheck, ok: false, errors } })
      throw new CommitRejectedError(errors, snapshot)
    }

    let bundle: CompiledBundle
    let key: string
    const isBase = filesHash === (await this.baseHash)
    if (isBase) {
      bundle = { js: '', css: '' }
      key = 'base'
    } else if (this.mode === 'server') {
      key = await this.key(filesHash)
      const compileStarted = performance.now()
      // the agent server usually compiled this exact snapshot already, at the end of the run
      let loaded = options.bundle && options.bundle.filesHash === filesHash ? await this.server!.load(options.bundle.key, filesHash).catch(() => null) : null
      if (!loaded) {
        const r = await this.server!.compile({ userId: this.userId, files, readonly: this.readonlySources(), manifest: this.config.manifest, components: this.requiredComponents(files) })
        lastCheck = { ok: r.ok, errors: r.errors, warnings: [], hash: filesHash, timeMs: r.timeMs }
        if (!r.ok || !r.key) return reject(r.errors)
        key = r.key
        loaded = await this.server!.load(r.key, filesHash)
        if (!loaded) return reject([{ file: '', line: 0, column: 0, text: 'the compiled bundle is not available under the bundle URL' }])
      }
      this.timings.lastServerCompileMs = performance.now() - compileStarted
      bundle = loaded
    } else {
      key = await this.key(filesHash)
      let result: CompileResult
      try {
        result = await this.compiler.compile(files)
      } catch (e) {
        if (this.fallBackToServer(e)) return this.commitFiles(files, message, draftParent, author, options)
        throw e
      }
      this.timings.lastCheckMs = result.timeMs
      lastCheck = summarize(result)
      if (!result.ok || !result.bundle) return reject(result.errors)
      bundle = result.bundle
    }

    let modules: Record<string, ModuleNamespace>
    if (isBase) {
      modules = this.config.fallback
    } else {
      try {
        modules = await this.loadBundle(bundle)
      } catch (e) {
        return reject([{ file: '', line: 0, column: 0, text: `Module failed to evaluate: ${(e as Error).message}` }])
      }
    }
    const missing = this.missingDefaults(modules, files)
    if (missing.length > 0) return reject(missing)
    if (!isBase && this.mode === 'browser') {
      try {
        bundle = await this.withCss(bundle, files)
      } catch (e) {
        return reject([{ file: '', line: 0, column: 0, text: `CSS generation failed: ${(e as Error).message}` }])
      }
    }
    await this.store.put(snapshot)
    if (!isBase && this.mode === 'browser') await this.store.bundleCache.put(key, bundle).catch(() => undefined)
    await this.store.setHead(this.userId, snapshot.id)
    this.redoStack = []
    this.set({ lastCheck, stale: false, stalePanels: [], safeMode: null })
    if (isBase) {
      this.endBoot()
      this.swap(this.fallbackModules(), null, true, snapshot)
    } else {
      this.beginBoot(snapshot.id)
      this.swap(modules, bundle, false, snapshot, key)
    }
    this.timings.lastCommitMs = performance.now() - started
    return snapshot
  }

  // --- navigation ---

  private async moveHead(target: Snapshot): Promise<Snapshot> {
    await this.activate(target)
    await this.store.setHead(this.userId, target.id)
    this.set({ head: target, stale: await this.isStale(target), stalePanels: [], safeMode: null })
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

  /** Report what happened to an agent request (no-op for stores without a request log). */
  async linkRequest(requestId: string, patch: RequestLinkPatch): Promise<RequestLinkResult | null> {
    return (await this.store.linkRequest?.(requestId, patch)) ?? null
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
