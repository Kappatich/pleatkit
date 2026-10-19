import { isComponentExport } from './component.js'
import { Compiler, isScript, type CompilerMetrics, type CompileOptions } from './compiler.js'
import { CssCompiler, type CssMetrics } from './css.js'
import { HeadConflictError, withTimeout } from './errors.js'
import { applyCss, defaultLoader, installExternals, type BundleLoader } from './loader.js'
import { isWritablePath, WRITABLE_EXT } from './paths.js'
import type { AgentRunRequest } from './protocol.js'
import { browserBootStorage, HEARTBEAT_MS, PAGE_ID, previousLoadFailed, readBoot, safeModeRequested, writeBoot, type BootStorage } from './safe-mode.js'
import { changedPaths, fileHashes, releaseHash } from './release.js'
import { bundleKey, contextHash, ServerBundles, type ServerBundlesOptions } from './server-bundles.js'
import type {
  CompileError,
  CompileMode,
  CompileResult,
  CompiledBundle,
  FileMap,
  ModuleNamespace,
  PleatkitConfig,
  RequestLinkPatch,
  RequestLinkResult,
  Snapshot,
  SnapshotAuthor,
  SnapshotStore,
} from './types.js'
import { clone, hashFiles, ulid } from './util.js'

export { WRITABLE_EXT }
/** Version of the Snapshot shape written by this runtime (F4). 2: `baseFiles`, `schemaVersion`. */
export const SNAPSHOT_SCHEMA_VERSION = 2
/** How long the first load may wait for the store before the original version is shown (code review 06 item 1). */
export const STORE_TIMEOUT_MS = 5_000
/** Evaluated bundles kept in memory, so undo/redo between recent versions does not import them again (06 item 10). */
export const MODULE_CACHE_SIZE = 8

export class CommitRejectedError extends Error {
  readonly code = 'commit-rejected'
  constructor(
    readonly errors: CompileError[],
    readonly snapshot: Snapshot,
  ) {
    super(`Commit rejected: ${errors.map((e) => `${e.file}:${e.line}:${e.column} ${e.text}`).join('; ')}`)
    this.name = 'CommitRejectedError'
  }
}

export class ZoneViolationError extends Error {
  readonly code = 'zone-violation'
  constructor(path: string) {
    super(`"${path}" is outside the dynamic zone and cannot be written`)
    this.name = 'ZoneViolationError'
  }
}

export { HeadConflictError }

export interface Draft {
  message: string
  parentId: string | null
  files: FileMap
}

/** Why the original version is shown although the user has their own (V1 B2). */
export interface SafeModeState {
  /** `crash`: the last load of this version did not mount; `param`: `?pleatkit=safe`. */
  reason: 'crash' | 'param'
  snapshotId: string
}

export interface EngineState {
  status: 'loading' | 'ready'
  head: Snapshot | null
  /** component id (`customer-card`) → module namespace */
  modules: Record<string, ModuleNamespace>
  /** Increments on every module swap (isolated frames resend their bundle on change). */
  version: number
  /**
   * Per panel: changes only when that panel's code changed (code review 06 item 10), so a swap remounts the
   * panels the edit touched and keeps the others, with their state, as they are.
   */
  panelVersions: Record<string, number>
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
  /** F6: flags from the store (app < org < user). */
  flags: Record<string, unknown>
  /** F6 kill switch (`pleatkit.enabled: false`): everyone sees the original version; no chat, no edits. */
  disabled: boolean
  /** F6 `edits.enabled: false`: users keep their versions but cannot make new edits. */
  editsEnabled: boolean
  /** The store did not answer the last load (code review 06 item 1); `refresh()` tries again. */
  offline: boolean
  /** "Show the original" is on (brainstorm 05 #12): the original version is shown, the head is unchanged. */
  previewingOriginal: boolean
}

/** What support and the user need to identify the version on screen (brainstorm 05 #12). */
export interface EngineDiagnostics {
  app: string
  userId: string
  /** The head snapshot, or null before the first edit. */
  snapshotId: string | null
  /** Last 8 characters of the snapshot id: short enough to read out in a ticket. */
  shortId: string | null
  /** The screen differs from the app's original version. */
  modified: boolean
  /** Panels whose own file differs from the original. */
  modifiedPanels: string[]
  /** A shared (non-panel) file of the zone differs from the original. */
  helpersModified: boolean
  author: SnapshotAuthor | null
  message: string | null
  createdAt: string | null
  bundle: string | null
  compileMode: CompileMode
  safeMode: SafeModeState['reason'] | null
  stale: boolean
  offline: boolean
  previewingOriginal: boolean
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
  compile(files: FileMap, options?: CompileOptions): Promise<CompileResult>
  readonly metrics: CompilerMetrics
}

export interface EngineOptions {
  userId: string
  store: SnapshotStore
  config: PleatkitConfig
  compiler?: CompilerLike
  loader?: BundleLoader
  cssCompiler?: CssCompiler
  /** App instance namespace (V1 B6). Default: the store's `appId` (HttpStore), else `default`. */
  namespace?: string
  /** Overrides `config.compile`. A configured public key always means `server`. */
  compile?: CompileMode
  /** Agent server for server compiles. Default `/agent`. */
  agentUrl?: string
  /** Same-origin URL of signed bundles. Default `/pleatkit/b`. */
  bundleUrl?: string
  /** Overrides `config.publicKey`. */
  publicKey?: string | null
  /** User token for server compiles (production). */
  token?: ServerBundlesOptions['token']
  /** Called when the agent server refuses the token (expired): return a fresh one (brainstorm 05 #19). */
  onAuthExpired?: ServerBundlesOptions['onAuthExpired']
  /** Server-compile client (tests inject one). */
  serverBundles?: ServerBundles
  /** In browser mode, compile on the server when esbuild-wasm cannot load (default true when an agent URL is known). */
  autoFallback?: boolean
  /** Where boot records for safe mode live (default localStorage). */
  bootStorage?: BootStorage | null
  /** Start in safe mode (default: `?pleatkit=safe` in the URL). */
  safeMode?: boolean
  heartbeatMs?: number
  /** Id of this page load (tests simulate a reload with another one). */
  pageId?: string
  /** How long a load waits for the store before showing the original version. Default 5 s. */
  storeTimeoutMs?: number
}

export interface CommitOptions {
  /** Agent request id, linked to the snapshot (and reported to the store's request log). */
  requestId?: string
  /** A bundle the agent server already compiled for these files (compile: 'server'), saving a round trip. */
  bundle?: { key: string; filesHash: string }
  /**
   * The head the edit was made from (code review 06 item 6): the agent was asked from head A; if the head is B
   * now (another tab, an admin rollback, an auto-rollback), the commit is refused with HeadConflictError.
   */
  expectedHeadId?: string | null
}

/** A plan for taking back one earlier edit (brainstorm 05 #13). */
export interface RevertPlan {
  target: Snapshot
  /** The new files when the edit can be taken back mechanically (nothing later touched its files). */
  files: FileMap | null
  /** Otherwise: what to send to the agent (`agentRequest(text, { revert })`). */
  revert: NonNullable<AgentRunRequest['revert']>
}

function summarize({ bundle: _bundle, ...rest }: CompileResult): Omit<CompileResult, 'bundle'> {
  return rest
}

/** `src/dynamic/customer-card.tsx` → `customer-card` */
export function componentId(path: string, roots: string[]): string {
  const root = roots.find((r) => path.startsWith(r)) ?? ''
  return path.slice(root.length).replace(/\.(tsx|ts|jsx|js|mts|mjs)$/, '')
}

// fileHashes, changedPaths and releaseHash live in release.ts (shared with the agent server's carry-over, C10)
export { fileHashes, changedPaths, releaseHash }

/** 32-bit FNV-1a: a cheap signature of panel sources (not a security hash). */
function fnv(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/**
 * Framework-agnostic core: snapshots, draft → check → commit, undo/redo/reset and module swapping.
 * All state-changing operations run one at a time through an internal queue.
 */
export class PleatkitEngine {
  readonly userId: string
  /** App instance namespace (V1 B6): its own externals registry, stylesheet and boot record. */
  readonly namespace: string
  readonly config: PleatkitConfig
  private readonly store: SnapshotStore
  private readonly compiler: CompilerLike
  private readonly loader: BundleLoader
  private readonly css: CssCompiler
  private readonly baseFiles: FileMap
  /** Hash of the original dynamic files only ("is this the original version?"). */
  private readonly originalHash: Promise<string>
  /** Release identity: written into snapshots as `baseHash`, compared for `stale`. */
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
  private readonly storeTimeoutMs: number
  private heartbeat: ReturnType<typeof setTimeout> | null = null
  private mode: CompileMode
  private readonly mounted = new Map<string, number>()
  private bundle: CompiledBundle | null = null
  private bundleId: string | null = null
  private redoStack: string[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private listeners = new Set<() => void>()
  private timings = { lastCheckMs: null as number | null, lastCommitMs: null as number | null, lastSwapMs: null as number | null, lastServerCompileMs: null as number | null }
  /** Evaluated bundles by key, least recently used first. */
  private readonly moduleCache = new Map<string, { modules: Record<string, ModuleNamespace>; bundle: CompiledBundle }>()
  private loads = 0
  /** Per panel: signature of the code it was built from, and whether that was the original version. */
  private panelSigs: Record<string, string> = {}
  private panelSeq = 0
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
      new ServerBundles({
        agentUrl,
        bundleUrl: options.bundleUrl ?? '/pleatkit/b',
        namespace: this.namespace,
        publicKey,
        ...(options.token ? { token: options.token } : {}),
        ...(options.onAuthExpired ? { onAuthExpired: options.onAuthExpired } : {}),
      })
    this.autoFallback = options.autoFallback ?? true
    const m = options.config.manifest
    this.baseFiles = Object.fromEntries(m.dynamic.map((f) => [f.path, f.source]))
    this.compiler =
      options.compiler ??
      new Compiler(
        { ...m, namespace: this.namespace, ...(m.protected ? { protected: m.protected, base: this.baseFiles } : {}) },
        // an inline source map only while developing (code review 06 item 7)
        { wasmURL: options.config.wasmURL, sourcemap: options.config.dev ? 'inline' : false },
      )
    this.loader = options.loader ?? defaultLoader
    this.css = options.cssCompiler ?? new CssCompiler(options.config.css)
    this.originalHash = hashFiles(this.baseFiles)
    this.baseFileHashes = fileHashes(this.baseFiles)
    this.ctxHash = contextHash(m, Object.fromEntries(m.readonly.map((f) => [f.path, f.source])))
    this.baseHash = Promise.all([this.originalHash, this.ctxHash]).then(([f, c]) => releaseHash(f, c, this.css.mode))
    this.registry = installExternals(options.config.externals, this.namespace, { allowedHosts: m.allowedHosts ?? [] })
    this.boot = options.bootStorage !== undefined ? options.bootStorage : browserBootStorage()
    this.bootKey = `pleatkit:boot:${this.namespace}:${this.userId}`
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
    this.forceSafe = options.safeMode ?? safeModeRequested()
    this.pageId = options.pageId ?? PAGE_ID
    this.storeTimeoutMs = options.storeTimeoutMs ?? STORE_TIMEOUT_MS
    this.state = {
      status: 'loading',
      head: null,
      modules: this.fallbackModules(),
      version: 0,
      panelVersions: {},
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
      flags: {},
      disabled: false,
      editsEnabled: true,
      offline: false,
      previewingOriginal: false,
    }
  }

  /**
   * Page-level listeners of this engine (safe mode's `pagehide`). The constructor has no side effects, so React
   * may build an engine during render (StrictMode builds two); `<PleatkitProvider>` attaches the one it uses in
   * an effect and detaches it on cleanup. Returns the detach function.
   */
  attach(): () => void {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => undefined
    // leaving on purpose before the version mounted is not a crash
    const onHide = () => {
      const rec = readBoot(this.boot, this.bootKey)
      if (rec && !rec.mounted && rec.closedAt === undefined) writeBoot(this.boot, this.bootKey, { ...rec, closedAt: Date.now() })
    }
    window.addEventListener('pagehide', onHide)
    return () => {
      // the engine is let go (another user signed in, the provider unmounted): that is leaving on purpose too
      onHide()
      window.removeEventListener('pagehide', onHide)
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

  /** Evaluated bundles held in memory and how many bundles were evaluated in total (code review 06 item 10). */
  moduleStats(): { cached: number; loads: number; limit: number } {
    return { cached: this.moduleCache.size, loads: this.loads, limit: MODULE_CACHE_SIZE }
  }

  /** `tailwind` when edits get runtime-compiled Tailwind CSS, `palette` otherwise. */
  get cssMode(): 'tailwind' | 'palette' {
    return this.css.mode
  }

  /** Where edits are compiled right now. */
  get compileMode(): CompileMode {
    return this.mode
  }

  /** Release identity of the app (what new snapshots record as `baseHash`). */
  currentBaseHash(): Promise<string> {
    return this.baseHash
  }

  /**
   * Tags for error reporting (V1 B7), e.g. `Sentry.setTags(engine.tags())`: which personal version and bundle
   * were live. Stack frames of edits read `pleatkit://<bundle>/bundle.js`.
   */
  tags(): Record<string, string> {
    const head = this.state.head
    return {
      'pleatkit.app': this.namespace,
      'pleatkit.snapshotId': head && !this.state.usingFallback ? head.id : 'base',
      'pleatkit.bundle': this.bundleId ?? 'base',
      'pleatkit.compile': this.mode,
      ...(this.state.safeMode ? { 'pleatkit.safeMode': this.state.safeMode.reason } : {}),
    }
  }

  /**
   * The version on screen, for a "modified" marker, a snapshot id in the drawer and in support tickets
   * (brainstorm 05 #12). The UI renders it; the engine only reports.
   */
  diagnostics(): EngineDiagnostics {
    const s = this.state
    const head = s.head
    const roots = this.config.manifest.dynamicRoots
    const panels = new Set(this.requiredComponents(head?.files ?? this.baseFiles))
    const files = head?.files ?? this.baseFiles
    const changed = [...new Set([...Object.keys(files), ...Object.keys(this.baseFiles)])].filter((p) => files[p] !== this.baseFiles[p])
    const live = Boolean(head?.parentId) && !s.usingFallback
    return {
      app: this.namespace,
      userId: this.userId,
      snapshotId: head?.id ?? null,
      shortId: head ? head.id.slice(-8) : null,
      modified: live && changed.length > 0,
      modifiedPanels: live ? changed.filter((p) => panels.has(p)).map((p) => componentId(p, roots)).sort() : [],
      helpersModified: live && changed.some((p) => !panels.has(p)),
      author: head?.author ?? null,
      message: head?.message ?? null,
      createdAt: head?.createdAt ?? null,
      bundle: this.bundleId,
      compileMode: this.mode,
      safeMode: s.safeMode?.reason ?? null,
      stale: s.stale,
      offline: s.offline,
      previewingOriginal: s.previewingOriginal,
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
      await Promise.all([this.compiler.compile(files, { rules: false }).catch(() => null), this.css.build(files).catch(() => '')])
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
    console.warn('[pleatkit] the in-browser compiler could not load; compiling edits on the agent server instead', e)
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
      // the head this request is made from: the commit is refused if it moved meanwhile (code review 06 item 6)
      expectedHeadId: this.state.head?.id ?? null,
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
    // Flags and the head in parallel, each within the store timeout: a store that is down or hangs must not
    // keep the panels on their placeholder (code review 06 item 1). The original version is shown instead.
    const [flagsR, headR] = await Promise.allSettled([
      this.store.flags ? withTimeout(this.store.flags(), this.storeTimeoutMs, 'the pleatkit store (flags)') : Promise.resolve({} as Record<string, unknown>),
      withTimeout(this.store.head(this.userId), this.storeTimeoutMs, 'the pleatkit store'),
    ])
    // F6: the kill switch wins over everything; a store that cannot answer leaves the defaults
    const flags = flagsR.status === 'fulfilled' ? flagsR.value : {}
    const disabled = flags['pleatkit.enabled'] === false
    this.set({ flags, disabled, editsEnabled: !disabled && flags['edits.enabled'] !== false })
    if (disabled) {
      if (!this.state.usingFallback) this.swap(this.fallbackModules(), null, true, this.state.head)
      return this.set({ status: 'ready', offline: false })
    }
    if (headR.status === 'rejected') {
      const message = (headR.reason as Error)?.message ?? String(headR.reason)
      return this.set({
        status: 'ready',
        offline: true,
        error: `Could not reach the pleatkit store (${message}); showing the ${this.state.usingFallback ? 'original' : 'last loaded'} version`,
      })
    }
    const wasOffline = this.state.offline
    this.set({ offline: false, ...(wasOffline ? { error: null } : {}) })
    const head = headR.value
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
   * Re-read the head from the store, e.g. after an admin rolled the user back on the server, or after the store
   * was unreachable. Does nothing while a draft is open.
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

  /** "Show the original" (brainstorm 05 #12): the original version on screen without moving the head; off restores. */
  previewOriginal(on: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (on === this.state.previewingOriginal) return
      const head = this.state.head
      if (on) {
        this.swap(this.fallbackModules(), null, true, head)
        return this.set({ previewingOriginal: true })
      }
      this.set({ previewingOriginal: false })
      if (head && !this.state.safeMode && !this.state.disabled) await this.activate(head)
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
      await this.commitFiles(files, 'Carried over to the new version of the app', head.id, 'user', {}, head.id)
      return true
    } catch (e) {
      if (e instanceof HeadConflictError) throw e
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

  /**
   * Swap the live modules. Panels whose code did not change keep their module namespace (and so their React
   * state); only changed panels get a new `panelVersions` entry and remount (code review 06 item 10).
   */
  private swap(modules: Record<string, ModuleNamespace>, bundle: CompiledBundle | null, usingFallback: boolean, head: Snapshot | null, bundleId: string | null = null): void {
    const roots = this.config.manifest.dynamicRoots
    const css = bundle?.css ?? ''
    this.bundle = usingFallback ? null : bundle
    this.bundleId = usingFallback ? null : bundleId
    const byId: Record<string, ModuleNamespace> = {}
    if (usingFallback) Object.assign(byId, modules)
    else for (const [path, ns] of Object.entries(modules)) byId[componentId(path, roots)] = ns
    const files = usingFallback ? this.baseFiles : (head?.files ?? this.baseFiles)
    const panelPaths = new Set(this.requiredComponents(files))
    const shared = fnv(
      Object.keys(files)
        .filter((p) => !panelPaths.has(p))
        .sort()
        .map((p) => `${p}\0${files[p]}`)
        .join('\0'),
    )
    const sigs: Record<string, string> = {}
    const versions: Record<string, number> = { ...this.state.panelVersions }
    for (const p of Object.keys(files)) {
      if (!isScript(p)) continue
      const id = componentId(p, roots)
      sigs[id] = `${usingFallback ? 'base' : 'edit'}:${shared}:${fnv(files[p]!)}`
      if (this.panelSigs[id] === sigs[id] && this.state.modules[id]) byId[id] = this.state.modules[id]!
      else versions[id] = ++this.panelSeq
    }
    this.panelSigs = sigs
    // V1 B4: panels capture their inputs and scroll before the swap and restore them after it
    for (const l of this.swapListeners) l()
    applyCss(css, this.namespace)
    this.set({ modules: byId, panelVersions: versions, usingFallback, version: this.state.version + 1, head, error: null })
  }

  private swapListeners = new Set<() => void>()

  /** Called synchronously right before modules are swapped (state preservation, V1 B4). */
  onBeforeSwap(listener: () => void): () => void {
    this.swapListeners.add(listener)
    return () => this.swapListeners.delete(listener)
  }

  /** Evaluate a bundle, or take it from the module cache (undo/redo between recent versions imports nothing). */
  private async loadBundle(bundle: CompiledBundle, key: string | null): Promise<Record<string, ModuleNamespace>> {
    const started = performance.now()
    const hit = key ? this.moduleCache.get(key) : undefined
    if (hit) {
      this.moduleCache.delete(key!)
      this.moduleCache.set(key!, hit)
      this.timings.lastSwapMs = performance.now() - started
      return hit.modules
    }
    await this.registry.ensure(bundle.externals)
    const modules = await this.loader(bundle)
    this.loads++
    if (key) {
      this.moduleCache.set(key, { modules, bundle })
      while (this.moduleCache.size > MODULE_CACHE_SIZE) this.moduleCache.delete(this.moduleCache.keys().next().value!)
    }
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

  private compileOptions(files: FileMap): CompileOptions {
    return { components: this.requiredComponents(files) }
  }

  /** The bundle of these files: server mode loads (or has the agent server compile) a signed one; browser mode compiles here. */
  private async bundleFor(files: FileMap, filesHash: string, snapshot: Snapshot): Promise<{ bundle: CompiledBundle; key: string }> {
    const key = await this.key(filesHash)
    const cached = this.moduleCache.get(key)
    if (cached) return { bundle: cached.bundle, key }
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
    let bundle = await this.store.bundleCache.get(key).catch(() => null)
    if (!bundle) {
      let result: CompileResult
      try {
        result = await this.compiler.compile(files, this.compileOptions(files))
      } catch (e) {
        if (this.fallBackToServer(e)) return this.bundleFor(files, filesHash, snapshot)
        throw e
      }
      if (!result.ok || !result.bundle) throw new CommitRejectedError(result.errors, snapshot)
      bundle = await this.withCss(result.bundle, files)
      // best effort: a cache that cannot store must not fail the load (code review 06 item 7)
      void this.store.bundleCache.put(key, bundle).catch(() => undefined)
    }
    return { bundle, key }
  }

  private readonlySources(): FileMap {
    return Object.fromEntries(this.config.manifest.readonly.map((f) => [f.path, f.source]))
  }

  /** Make the snapshot's modules live: base → fallback bundle, otherwise a cached, loaded or freshly compiled bundle. */
  private async activate(snapshot: Snapshot): Promise<void> {
    const hash = await hashFiles(snapshot.files)
    if (hash === (await this.originalHash)) {
      this.endBoot()
      return this.swap(this.fallbackModules(), null, true, snapshot)
    }
    const { bundle, key } = await this.bundleFor(snapshot.files, hash, snapshot)
    const modules = await this.loadBundle(bundle, key)
    this.beginBoot(snapshot.id)
    this.swap(modules, bundle, false, snapshot, key)
  }

  /** esbuild's CSS (from `.css` files in the zone) followed by the Tailwind utilities the zone uses. */
  private async withCss(bundle: CompiledBundle, files: FileMap): Promise<CompiledBundle> {
    const tailwind = await this.css.build(files)
    return { ...bundle, css: [bundle.css, tailwind].filter(Boolean).join('\n') }
  }

  /**
   * Default-export check for panels, on the evaluated modules, before the head moves. The same rule as the
   * static one in `check` (a function, or memo/forwardRef/lazy; never a number or a plain object).
   */
  private missingDefaults(modules: Record<string, ModuleNamespace>, files: FileMap): CompileError[] {
    return this.requiredComponents(files)
      .filter((path) => !isComponentExport(modules[path]?.default))
      .map((path) => ({
        file: path,
        line: 0,
        column: 0,
        text: path in files ? `no default export in ${path}` : `${path} was removed, but a <Dynamic> panel needs it`,
        rule: 'default-export',
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

  /**
   * Move the stored head with compare-and-set (code review 06 item 6). On a conflict the head is reloaded from
   * the store after the current operation, and HeadConflictError is thrown.
   */
  private async setHeadCas(id: string, expected: string | null): Promise<void> {
    try {
      await this.store.setHead(this.userId, id, expected)
    } catch (e) {
      const conflict = e instanceof HeadConflictError || (e as { status?: number })?.status === 409
      if (!conflict) throw e
      void this.enqueue(() => this.loadHead())
      throw e instanceof HeadConflictError ? e : new HeadConflictError(expected, null)
    }
  }

  // --- draft ---

  private isWritable(path: string): boolean {
    return isWritablePath(path, this.config.manifest.dynamicRoots)
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
    /**
     * check + store + set head + swap. Throws CommitRejectedError if the draft does not compile or evaluate,
     * HeadConflictError if the head moved since the draft (or the agent request) was made.
     */
    commit: (author: SnapshotAuthor = 'user', options: CommitOptions = {}): Promise<Snapshot> =>
      this.enqueue(async () => {
        if (!this.state.editsEnabled) throw new Error('pleatkit: edits are switched off for this app (flags)')
        const draft = this.requireDraft()
        const current = this.state.head?.id ?? null
        const expected = options.expectedHeadId !== undefined ? options.expectedHeadId : draft.parentId
        if (expected !== current) {
          this.set({ draft: null })
          void this.enqueue(() => this.loadHead())
          throw new HeadConflictError(expected, current)
        }
        try {
          const snapshot = await this.commitFiles(draft.files, draft.message, draft.parentId, author, options, current)
          this.set({ draft: null })
          return snapshot
        } catch (e) {
          if (e instanceof HeadConflictError) this.set({ draft: null })
          throw e
        }
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
      return await this.compiler.compile(files, this.compileOptions(files))
    } catch (e) {
      if (this.fallBackToServer(e)) return this.checkFiles(files)
      throw e
    }
  }

  /** The commit itself: compile (here or on the server), evaluate, check exports, store, move the head, swap. */
  private async commitFiles(files: FileMap, message: string, draftParent: string | null, author: SnapshotAuthor, options: CommitOptions, expectedHead: string | null): Promise<Snapshot> {
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
    const isBase = filesHash === (await this.originalHash)
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
        result = await this.compiler.compile(files, this.compileOptions(files))
      } catch (e) {
        if (this.fallBackToServer(e)) return this.commitFiles(files, message, draftParent, author, options, expectedHead)
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
        modules = await this.loadBundle(bundle, key)
      } catch (e) {
        return reject([{ file: '', line: 0, column: 0, text: `Module failed to evaluate: ${(e as Error).message}` }])
      }
    }
    const missing = this.missingDefaults(modules, files)
    if (missing.length > 0) {
      this.moduleCache.delete(key)
      return reject(missing)
    }
    if (!isBase && this.mode === 'browser') {
      try {
        bundle = await this.withCss(bundle, files)
      } catch (e) {
        return reject([{ file: '', line: 0, column: 0, text: `CSS generation failed: ${(e as Error).message}` }])
      }
    }
    // the cached entry gets the bundle with its final CSS (browser mode adds Tailwind after evaluation)
    const entry = this.moduleCache.get(key)
    if (entry) entry.bundle = bundle
    await this.store.put(snapshot)
    // best effort, not awaited: the cache must never fail or delay a commit (code review 06 item 7)
    if (!isBase && this.mode === 'browser') void this.store.bundleCache.put(key, bundle).catch(() => undefined)
    await this.setHeadCas(snapshot.id, expectedHead)
    this.redoStack = []
    this.set({ lastCheck, stale: false, stalePanels: [], safeMode: null, previewingOriginal: false })
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

  /** Returns false when the head moved elsewhere meanwhile (it is reloaded instead). */
  private async moveHead(target: Snapshot): Promise<boolean> {
    try {
      await this.setHeadCas(target.id, this.state.head?.id ?? null)
    } catch (e) {
      if (e instanceof HeadConflictError) return false
      throw e
    }
    await this.activate(target)
    this.set({ head: target, stale: await this.isStale(target), stalePanels: [], safeMode: null, previewingOriginal: false })
    return true
  }

  private async undoNow(): Promise<Snapshot | null> {
    const head = this.state.head
    if (!head?.parentId) return null
    const parent = await this.store.get(head.parentId)
    if (!(await this.moveHead(parent))) return null
    this.redoStack.push(head.id)
    this.set({})
    return parent
  }

  /** head = head.parent. Returns the new head, or null if there is nothing to undo (or the head moved elsewhere). */
  undo(): Promise<Snapshot | null> {
    return this.enqueue(() => this.undoNow())
  }

  redo(): Promise<Snapshot | null> {
    return this.enqueue(async () => {
      const id = this.redoStack.pop()
      if (!id) return null
      const target = await this.store.get(id)
      return (await this.moveHead(target)) ? target : null
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
        if (!(await this.moveHead(fresh))) return null
        this.redoStack = []
        this.set({})
        return fresh
      }
      if (!head.parentId) return head
      const base = await this.root(head)
      if (!(await this.moveHead(base))) return null
      this.redoStack.push(head.id)
      this.set({})
      return base
    })
  }

  /**
   * Undo only if `snapshotId` is still the head (used by error boundaries; safe to call repeatedly). The check
   * runs inside the queue (code review 06 item 3): two crashed panels of one edit undo it once, not twice.
   */
  rollback(snapshotId: string): Promise<Snapshot | null> {
    return this.enqueue(async () => {
      if (this.state.head?.id !== snapshotId) return null
      const s = await this.undoNow()
      this.redoStack = this.redoStack.filter((id) => id !== snapshotId)
      this.set({})
      return s
    })
  }

  /**
   * How to take back one earlier edit while keeping the ones after it (brainstorm 05 #13). When no later edit
   * touched its files, the plan carries the new files and `revert()` applies them; otherwise the agent gets the
   * edit's diff to reverse on the current files (`agentRequest(text, { revert: plan.revert })`).
   */
  async revertPlan(snapshotId: string): Promise<RevertPlan> {
    const head = this.state.head
    if (!head) throw new Error('pleatkit: nothing to undo yet')
    const chain: string[] = []
    for (let s: Snapshot | null = head; s; s = s.parentId ? await this.store.get(s.parentId) : null) chain.push(s.id)
    if (!chain.includes(snapshotId)) throw new Error('pleatkit: that edit is not part of the current version')
    const target = await this.store.get(snapshotId)
    if (!target.parentId) throw new Error('pleatkit: the original version cannot be undone')
    const parent = await this.store.get(target.parentId)
    const paths = [...new Set([...Object.keys(parent.files), ...Object.keys(target.files)])].filter((p) => parent.files[p] !== target.files[p]).sort()
    const before: FileMap = {}
    const after: FileMap = {}
    for (const p of paths) {
      if (p in parent.files) before[p] = parent.files[p]!
      if (p in target.files) after[p] = target.files[p]!
    }
    const untouchedSince = paths.every((p) => head.files[p] === target.files[p])
    let files: FileMap | null = null
    if (untouchedSince) {
      files = clone(head.files)
      for (const p of paths) {
        if (p in parent.files) files[p] = parent.files[p]!
        else delete files[p]
      }
    }
    return { target, files, revert: { snapshotId, message: target.message, before, after } }
  }

  /** Take back an earlier edit when it can be done without the agent; returns null when the agent is needed. */
  revert(snapshotId: string): Promise<Snapshot | null> {
    return this.revertPlan(snapshotId).then((plan) => {
      if (!plan.files) return null
      const files = plan.files
      return this.enqueue(async () => {
        const head = this.state.head
        if (!head) return null
        return this.commitFiles(files, `Undid: ${plan.target.message}`.slice(0, 200), head.id, 'user', {}, head.id)
      })
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
