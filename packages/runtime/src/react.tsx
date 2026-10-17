import {
  Component,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import { MORPHKIT_FRAME } from './compiler.js'
import { MorphkitEngine, type CompilerLike, type EngineOptions, type EngineState } from './engine.js'
import { IsolatedFrame } from './isolated.js'
import type { BundleLoader } from './loader.js'
import { capturePanel, restorePanel, type PanelState } from './preserve.js'
import type { CompileMode, MorphkitConfig, SnapshotStore } from './types.js'

interface ContextValue {
  engine: MorphkitEngine
  autoRollbackMs: number
}

const MorphkitContext = createContext<ContextValue | null>(null)

export interface MorphkitProviderProps {
  /** `import * as config from 'virtual:morphkit'` */
  config: MorphkitConfig
  store: SnapshotStore
  userId: string
  /** Auto-rollback delay after a dynamic component crashes. Default 10 000 ms. */
  autoRollbackMs?: number
  compiler?: CompilerLike
  loader?: BundleLoader
  /** App instance namespace (V1 B6). Default: the store's `appId`, else `default`. */
  namespace?: string
  /** Overrides the plugin's `compile` option (`server` by default). */
  compile?: CompileMode
  /** Agent server URL for server compiles. Default `/agent`. */
  agentUrl?: string
  /** Same-origin URL of signed bundles. Default `/morphkit/b`. */
  bundleUrl?: string
  /** Overrides the plugin's `publicKey` (only bundles signed by it run). */
  publicKey?: string | null
  /** User token for server compiles (production): the same token as for store-server. */
  token?: EngineOptions['token']
  /** Called when a server answers 401 (the token expired): return a fresh token (brainstorm 05 #19). */
  onAuthExpired?: EngineOptions['onAuthExpired']
  /** Language of the safe-mode banner. Default `en`. */
  locale?: 'en' | 'ru'
  /** Show the safe-mode banner (V1 B2). Default true. */
  safeModeBanner?: boolean
  children?: ReactNode
}

export function MorphkitProvider({
  config,
  store,
  userId,
  autoRollbackMs = 10_000,
  compiler,
  loader,
  namespace,
  compile,
  agentUrl,
  bundleUrl,
  publicKey,
  token,
  onAuthExpired,
  locale = 'en',
  safeModeBanner = true,
  children,
}: MorphkitProviderProps) {
  // the latest token functions, without rebuilding the engine when the host passes new closures
  const auth = useRef({ token, onAuthExpired })
  auth.current = { token, onAuthExpired }
  // One engine per user and configuration, made during render: switching users never unmounts the host's tree
  // (code review 06 item 11), the new user's panels show their placeholder until the head is loaded. The engine
  // constructor has no side effects (StrictMode may build two); listeners are attached in an effect.
  const engine = useMemo(
    () =>
      new MorphkitEngine({
      config,
      store,
      userId,
      compiler,
      loader,
      ...(namespace ? { namespace } : {}),
      ...(compile ? { compile } : {}),
      ...(agentUrl ? { agentUrl } : {}),
      ...(bundleUrl ? { bundleUrl } : {}),
        ...(publicKey !== undefined ? { publicKey } : {}),
        ...(token ? { token: (o?: { refresh?: boolean }) => (typeof auth.current.token === 'function' ? auth.current.token(o) : auth.current.token) } : {}),
        ...(onAuthExpired ? { onAuthExpired: () => auth.current.onAuthExpired?.() } : {}),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- token functions are read through the ref above
    [config, store, userId, compiler, loader, namespace, compile, agentUrl, bundleUrl, publicKey, Boolean(token), Boolean(onAuthExpired)],
  )

  useEffect(() => engine.attach(), [engine])
  useEffect(() => {
    void engine.init()
  }, [engine])

  const value = useMemo(() => ({ engine, autoRollbackMs }), [engine, autoRollbackMs])
  return (
    <MorphkitContext.Provider value={value}>
      {safeModeBanner && <SafeModeBanner locale={locale} />}
      {children}
    </MorphkitContext.Provider>
  )
}

function useCtx(): ContextValue {
  const ctx = useContext(MorphkitContext)
  if (!ctx) throw new Error('useMorphkit must be used inside <MorphkitProvider>')
  return ctx
}

/** The engine API: draft.*, undo, redo, reset, history, metrics. */
export function useMorphkit(): MorphkitEngine {
  return useCtx().engine
}

export function useMorphkitState(): EngineState {
  const engine = useMorphkit()
  return useSyncExternalStore(engine.subscribe, engine.getState, engine.getState)
}

/** `engine.tags()` that follow the live version (V1 B7), e.g. `useEffect(() => Sentry.setTags(tags), [tags])`. */
export function useMorphkitTags(): Record<string, string> {
  const engine = useMorphkit()
  useMorphkitState() // re-render when the live version changes
  return engine.tags()
}

export interface DynamicProps {
  /** File `src/dynamic/<id>.tsx` with a default export. */
  id: string
  props?: Record<string, unknown>
  /** Shown while the user's version is loading. */
  loading?: ReactNode
  /**
   * Render inside a sandboxed iframe (`sandbox="allow-scripts"`, opaque origin): the panel's code cannot
   * reach the page, its cookies or storage. Props must be serializable (they cross via postMessage).
   * Needs `isolated: true` in the Vite plugin options.
   */
  isolated?: boolean
}

export function Dynamic({ id, props, loading = null, isolated = false }: DynamicProps) {
  const { autoRollbackMs } = useCtx()
  const engine = useMorphkit()
  const state = useMorphkitState()
  const container = useRef<HTMLDivElement>(null)
  const saved = useRef<PanelState | null>(null)

  useEffect(() => engine.mount(id), [engine, id])

  // V1 B4: what the user typed and where they scrolled survive the swap to a new version
  useEffect(
    () =>
      engine.onBeforeSwap(() => {
        saved.current = container.current ? capturePanel(container.current) : null
      }),
    [engine],
  )
  const panelVersion = state.panelVersions[id] ?? 0
  useLayoutEffect(() => {
    const s = saved.current
    saved.current = null
    // only a panel whose code changed was remounted and needs its inputs and scroll back
    if (!s || !container.current) return
    restorePanel(container.current, s)
  }, [panelVersion])

  // Until the user's head is known, show the placeholder rather than flash the original version.
  if (state.status === 'loading') return <div data-morphkit-id={id} data-morphkit-loading="">{loading}</div>

  const headId = state.head?.parentId && !state.usingFallback ? state.head.id : null
  const stale = state.stalePanels.includes(id) ? '' : undefined
  // "modified" marker for the UI and support (brainstorm 05 #12): this panel's code is an edit
  const modified = headId && engine.diagnostics().modifiedPanels.includes(id) ? '' : undefined
  // code review 06 item 8: with `isolateEdits`, every edited panel runs in the sandboxed frame
  const runIsolated = isolated || (Boolean(engine.config.isolateEdits) && headId !== null && Boolean(engine.isolatedHostUrl()))
  if (runIsolated) {
    return (
      <div data-morphkit-id={id} data-morphkit-isolated="" data-morphkit-stale={stale} data-morphkit-modified={modified} style={{ display: 'contents' }}>
        <IsolatedFrame id={id} props={props ?? {}} headId={headId} autoRollbackMs={autoRollbackMs} />
      </div>
    )
  }

  const C = state.modules[id]?.default as ComponentType<Record<string, unknown>> | undefined
  return (
    <div ref={container} data-morphkit-id={id} data-morphkit-stale={stale} data-morphkit-modified={modified} style={{ display: 'contents' }}>
      <PanelBoundary key={panelVersion} id={id} headId={headId} autoRollbackMs={autoRollbackMs} engine={engine}>
        {C ? <C {...props} /> : <MissingComponent id={id} />}
      </PanelBoundary>
    </div>
  )
}

function MissingComponent({ id }: { id: string }): ReactNode {
  throw new Error(`Dynamic component "${id}" has no default export`)
}

/**
 * V1 B3: was this error thrown by an edit's code? Only then may the boundary roll the edit back. Frames of an
 * edit come from its bundle (`morphkit://…`, `/morphkit/b/…`, or a `blob:` module); an error with none of them
 * (bad data from the API, a host hook) is not the edit's fault.
 */
export function isEditFault(error: unknown): boolean {
  const stack = error instanceof Error ? (error.stack ?? '') : ''
  return MORPHKIT_FRAME.test(stack) || /\bblob:/.test(stack)
}

export interface BoundaryProps {
  id: string
  /** Snapshot to roll back from; null when showing the original version. */
  headId: string | null
  autoRollbackMs: number
  engine: MorphkitEngine
  children: ReactNode
}

class PanelBoundary extends Component<BoundaryProps, { error: Error | null }> {
  override state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[morphkit] dynamic component "${this.props.id}" crashed`, error, info.componentStack)
  }

  override render() {
    const { error } = this.state
    if (!error) return this.props.children
    const fault = isEditFault(error)
    return <CrashBanner {...this.props} headId={fault ? this.props.headId : null} error={error} fault={fault ? 'edit' : 'app'} onRetry={() => this.setState({ error: null })} />
  }
}

const bannerStyle = {
  border: '1px solid #fca5a5',
  background: '#fef2f2',
  color: '#7f1d1d',
  borderRadius: 8,
  padding: 12,
  font: '14px system-ui, sans-serif',
} as const
const buttonStyle = { marginRight: 8, padding: '4px 10px', borderRadius: 6, border: '1px solid #b91c1c', background: '#fff', cursor: 'pointer' } as const

export function CrashBanner({
  id,
  headId,
  autoRollbackMs,
  engine,
  error,
  fault = 'edit',
  onRetry,
}: Omit<BoundaryProps, 'children'> & { error: Error; fault?: 'edit' | 'app'; onRetry?: () => void }) {
  const [kept, setKept] = useState(false)
  const [left, setLeft] = useState(Math.ceil(autoRollbackMs / 1000))

  useEffect(() => {
    if (!headId || kept) return
    const started = Date.now()
    const tick = setInterval(() => setLeft(Math.max(0, Math.ceil((autoRollbackMs - (Date.now() - started)) / 1000))), 250)
    const timer = setTimeout(() => void engine.rollback(headId), autoRollbackMs)
    return () => {
      clearInterval(tick)
      clearTimeout(timer)
    }
  }, [headId, kept, autoRollbackMs, engine])

  if (fault === 'app') {
    return (
      <div role="alert" data-testid="morphkit-crash" data-morphkit-crash={id} data-morphkit-fault="app" style={bannerStyle}>
        <strong>The “{id}” panel hit an error that is not caused by your edit.</strong>
        <div style={{ margin: '6px 0', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{error.message}</div>
        {onRetry && (
          <button type="button" style={buttonStyle} onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    )
  }
  return (
    <div role="alert" data-testid="morphkit-crash" data-morphkit-crash={id} data-morphkit-fault="edit" style={bannerStyle}>
      <strong>The last edit broke the “{id}” panel.</strong>
      <div style={{ margin: '6px 0', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{error.message}</div>
      {headId ? (
        <div>
          <button type="button" style={buttonStyle} onClick={() => void engine.rollback(headId)}>
            Roll back
          </button>
          {!kept && (
            <button type="button" style={buttonStyle} onClick={() => setKept(true)}>
              Keep
            </button>
          )}
          <span style={{ fontSize: 12 }}>{kept ? 'Auto-rollback cancelled.' : `Rolling back automatically in ${left} s.`}</span>
        </div>
      ) : (
        <div style={{ fontSize: 12 }}>This is the original version; nothing to roll back.</div>
      )}
    </div>
  )
}

const SAFE_TEXT = {
  en: {
    crash: 'Your customized version did not load last time, so the original version is shown.',
    param: 'Safe mode: the original version is shown.',
    retry: 'Try my version again',
    reset: 'Reset to the original',
  },
  ru: {
    crash: 'Ваша версия не загрузилась в прошлый раз, поэтому показана исходная.',
    param: 'Безопасный режим: показана исходная версия.',
    retry: 'Попробовать мою версию снова',
    reset: 'Сбросить к исходной',
  },
}

/** V1 B2: shown while the original version stands in for the user's own one. */
export function SafeModeBanner({ locale = 'en' }: { locale?: 'en' | 'ru' }) {
  const engine = useMorphkit()
  const state = useMorphkitState()
  if (!state.safeMode) return null
  const t = SAFE_TEXT[locale] ?? SAFE_TEXT.en
  return (
    <div
      role="status"
      data-testid="morphkit-safe-mode"
      data-reason={state.safeMode.reason}
      style={{ ...bannerStyle, borderColor: '#fcd34d', background: '#fffbeb', color: '#78350f', borderRadius: 0, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}
    >
      <span>{t[state.safeMode.reason]}</span>
      <button type="button" style={buttonStyle} data-testid="morphkit-safe-retry" onClick={() => void engine.leaveSafeMode()}>
        {t.retry}
      </button>
      <button type="button" style={buttonStyle} data-testid="morphkit-safe-reset" onClick={() => void engine.reset()}>
        {t.reset}
      </button>
    </div>
  )
}
