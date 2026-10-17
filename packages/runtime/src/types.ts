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
  /**
   * Hash of the app's base snapshot (manifest `dynamic`) this snapshot was made from. When the app ships
   * a new base, older snapshots become `stale`. Missing on snapshots written before Stage 2.
   */
  baseHash?: string
  /** Agent request that produced this snapshot (store-server `requests.id`), when known. */
  requestId?: string
  /**
   * Per-file hashes of the base this snapshot was made from (V1 B5): after a release, only edits to files the
   * release also changed need a decision; the rest is carried over by itself.
   */
  baseFiles?: Record<string, string>
  /** Shape version of the snapshot (F4); missing means 1. */
  schemaVersion?: number
}

export interface CompiledBundle {
  js: string
  css: string
  /** Host modules the bundle imports; resolved before it runs. Missing on old bundles (then all are resolved). */
  externals?: string[]
  /** Server bundle (compile: 'server'): its URL and SRI digest; `js` is empty because the browser loads it by URL. */
  url?: string
  integrity?: string
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
  /**
   * Move the user's head. With `expectedHeadId` (code review 06 item 6) the store moves it only if the head is
   * still that snapshot (`null`: the user has no head yet) and throws HeadConflictError otherwise: another tab,
   * device, admin rollback or auto-rollback moved it in between.
   */
  setHead(userId: string, id: string, expectedHeadId?: string | null): Promise<void>
  bundleCache: BundleCache
  /**
   * Optional: attach the outcome of an agent request (logged by the agent server) to the snapshot it
   * produced. Implemented by HttpStore; local stores have no request log.
   */
  linkRequest?(requestId: string, patch: RequestLinkPatch): Promise<RequestLinkResult | null>
  /**
   * Optional (F6): flags for this user (app < org < user), e.g. the kill switch `morphkit.enabled` and
   * `edits.enabled`. Implemented by HttpStore.
   */
  flags?(): Promise<Record<string, unknown>>
}

/**
 * `pending-review`: applied for the user right away, but the app runs with `moderation: 'review'`, so the
 * edit waits at the top of the admin's list until it is approved or rolled back (DECISIONS item 15).
 */
export type RequestStatus =
  | 'proposed'
  | 'applied'
  | 'pending-review'
  | 'clarifying'
  | 'rejected'
  | 'pending-admin'
  | 'in-progress'
  | 'rolled-back'
  | 'failed'
  /** Not run: off-topic, over quota or switched off. */
  | 'refused'

/** Moderation of agent edits per app: `off` (default) or `review` (apply now, admin reviews after). */
export type Moderation = 'off' | 'review'

/** What store-server made of a link: the request's final status (`pending-review` under moderation). */
export interface RequestLinkResult {
  status: RequestStatus
}

export interface RequestLinkPatch {
  snapshotId?: string
  status: RequestStatus
  /** Why the browser could not apply the agent's result, if it could not. */
  error?: string
}

export interface CompileError {
  file: string
  line: number
  column: number
  text: string
  /** Set for a static-rule violation (agent server `check`), e.g. `no-eval`. */
  rule?: string
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
  /**
   * Runtime CSS of the app (`css: 'tailwind'`): Tailwind input (theme, `@theme`/`@utility` blocks) so the agent
   * server can compile CSS for server bundles too, and its hash for bundle keys. Missing on older builds.
   */
  css?: { mode: 'tailwind' | 'palette'; input?: string; hash: string }
  /** Selectors of elements edits must keep visible (brainstorm 05 #20), e.g. `[data-consent]`. */
  protected?: string[]
  /** Design-system profile for the agent (brainstorm 05 #10, 04 §1): one line per component, from `.d.ts`. */
  designSystem?: { digest: string; docs?: string }
  /** Data contracts for the agent: entities and client methods, from the readonly zone's `.d.ts`. */
  dataContracts?: { digest: string }
}

export type ModuleNamespace = Record<string, unknown>
/** A host module: its namespace, or a loader for it (lazy externals, V1 B6). */
export type ExternalEntry = ModuleNamespace | (() => Promise<ModuleNamespace>)

/** The Tailwind compiler module generated by the Vite plugin (`virtual:morphkit/tailwind`). */
export interface TailwindModule {
  compile(
    css: string,
    options: {
      base?: string
      loadStylesheet?: (id: string, base: string) => Promise<{ path: string; base: string; content: string }>
      loadModule?: (id: string, base: string, resourceHint: 'plugin' | 'config') => Promise<never>
    },
  ): Promise<{ build(candidates: string[]): string }>
  /** Input CSS: theme + utilities layers and the app's own `@theme` / `@utility` / `@custom-variant` blocks. */
  input: string
  /** Stylesheets that `input` imports, by specifier (`tailwindcss/theme.css`). */
  stylesheets: Record<string, string>
  /** Readonly-zone sources whose classes are compiled together with dynamic code, so utilities keep Tailwind's order. */
  extraSources?: string[]
}

/**
 * How CSS for runtime edits is produced.
 * - `tailwind`: Tailwind 4 compiles exactly the classes used by the dynamic zone, in the browser, at commit.
 * - `palette`: no runtime CSS; the app pre-generates a safelist of utilities at build time.
 */
export interface CssConfig {
  mode: 'tailwind' | 'palette'
  load: (() => Promise<TailwindModule>) | null
}

/**
 * Self-contained iframe host for `isolated` panels (React + externals + fallback), served as a separate
 * classic script (DECISIONS item 16). The opaque-origin frame loads it with `crossorigin="anonymous"`, so the
 * file must be served with `Access-Control-Allow-Origin: *` (the Vite plugin does this in dev and preview).
 */
export interface IsolatedConfig {
  /** URL of the host script, absolute or relative to the page. */
  url: string
}

/**
 * Where edits are compiled (V1 B1, DECISIONS 22):
 * - `server` (default of the Vite plugin): the agent server compiles with native esbuild, signs the bundle, and
 *   the browser loads it from the app's origin with `import()`. No WebAssembly, no `blob:` in the CSP.
 * - `browser`: esbuild-wasm in the page (fast path for development and LocalStore without an agent server);
 *   falls back to `server` by itself when WebAssembly cannot load.
 */
export type CompileMode = 'server' | 'browser'

/** Everything the Vite plugin generates, as `import * as config from 'virtual:morphkit'`. */
export interface MorphkitConfig {
  manifest: MorphkitManifest
  externals: Record<string, ExternalEntry>
  fallback: Record<string, ModuleNamespace>
  wasmURL: string | null
  css?: CssConfig
  isolated?: IsolatedConfig | null
  /** Default `browser` when absent (configs from before Stage 4a); the Vite plugin writes `server` by default. */
  compile?: CompileMode
  /**
   * ed25519 public key (base64url) of the app key (V1 A3). When set, the runtime runs only bundles signed by
   * it, and edits are always compiled on the server. `npx morphkit keys public` prints it.
   */
  publicKey?: string | null
  /** Development build (`vite serve`): browser compiles keep an inline source map. Production bundles have none. */
  dev?: boolean
  /**
   * Render every panel whose live version is an edit inside the sandboxed iframe, as `<Dynamic isolated>` would
   * (code review 06 item 8). Default false (same realm, the demo's mode); needs `isolated: true` in the plugin.
   */
  isolateEdits?: boolean
  /**
   * Send the visible text of the panel the user points at to the agent (brainstorm 05 #3). Default false: only
   * the structure (tags, classes, test ids, text lengths) leaves the page; `data-morphkit-private` subtrees never do.
   */
  sendDomText?: boolean
}
