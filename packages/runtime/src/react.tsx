import {
  Component,
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import { MorphkitEngine, type CompilerLike, type EngineState } from './engine.js'
import type { BundleLoader } from './loader.js'
import type { MorphkitConfig, SnapshotStore } from './types.js'

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
  children?: ReactNode
}

export function MorphkitProvider({ config, store, userId, autoRollbackMs = 10_000, compiler, loader, children }: MorphkitProviderProps) {
  // One engine per user; switching users swaps the whole engine.
  const [engine, setEngine] = useState(() => new MorphkitEngine({ config, store, userId, compiler, loader }))
  const current = engine.userId === userId ? engine : null

  useEffect(() => {
    if (!current) setEngine(new MorphkitEngine({ config, store, userId, compiler, loader }))
  }, [current, config, store, userId, compiler, loader])

  useEffect(() => {
    void engine.init()
  }, [engine])

  if (!current) return null
  return <MorphkitContext.Provider value={{ engine: current, autoRollbackMs }}>{children}</MorphkitContext.Provider>
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

export interface DynamicProps {
  /** File `src/dynamic/<id>.tsx` with a default export. */
  id: string
  props?: Record<string, unknown>
  /** Shown while the user's version is loading. */
  loading?: ReactNode
}

export function Dynamic({ id, props, loading = null }: DynamicProps) {
  const { autoRollbackMs } = useCtx()
  const engine = useMorphkit()
  const state = useMorphkitState()

  // Until the user's head is known, show the placeholder rather than flash the original version.
  if (state.status === 'loading') return <div data-morphkit-id={id} data-morphkit-loading="">{loading}</div>

  const C = state.modules[id]?.default as ComponentType<Record<string, unknown>> | undefined
  const headId = state.head?.parentId ? state.head.id : null
  return (
    <div data-morphkit-id={id} style={{ display: 'contents' }}>
      <PanelBoundary key={state.version} id={id} headId={headId} autoRollbackMs={autoRollbackMs} engine={engine}>
        {C ? <C {...props} /> : <MissingComponent id={id} />}
      </PanelBoundary>
    </div>
  )
}

function MissingComponent({ id }: { id: string }): ReactNode {
  throw new Error(`Dynamic component "${id}" has no default export`)
}

interface BoundaryProps {
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
    return <CrashBanner {...this.props} error={error} />
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

function CrashBanner({ id, headId, autoRollbackMs, engine, error }: BoundaryProps & { error: Error }) {
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

  return (
    <div role="alert" data-testid="morphkit-crash" data-morphkit-crash={id} style={bannerStyle}>
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
