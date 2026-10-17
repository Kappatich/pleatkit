import { useCallback, useEffect, useRef, useState } from 'react'
import { CommitRejectedError, useMorphkit, useMorphkitState, type AgentProgress, type AgentResult, type CompileError, type Snapshot } from '@morphkit/runtime'
import { ElementPicker } from './picker.js'
import { callAgent } from './sse.js'
import { useMorphkitUiStyles } from './styles.js'

export interface MorphkitChatProps {
  /** Base URL of @morphkit/agent, e.g. `/agent` behind the app's proxy. */
  agentUrl?: string
  /** Store namespace sent to the agent for its request log. */
  appId?: string
  title?: string
  /** Example requests shown in an empty chat. */
  examples?: string[]
  defaultOpen?: boolean
  launcherLabel?: string
  /** Shift the page left while the drawer is open so the panels being changed stay visible. Default true. */
  pushContent?: boolean
}

type TurnStatus = 'running' | 'applied' | 'nothing' | 'needs-backend' | 'failed' | 'rejected'

interface Step {
  text: string
  tone?: 'good' | 'bad'
}

interface Turn {
  id: number
  request: string
  status: TurnStatus
  steps: Step[]
  summary?: string
  errors?: CompileError[]
  /** Send → re-render, and the agent's own share. */
  timing?: { totalMs: number; agentMs: number; commitMs: number }
  result?: AgentResult
}

interface Toast {
  id: number
  text: string
  tone: 'ok' | 'bad' | 'admin'
}

const PANEL_TAG = /\[panel:\s*([\w./-]+)\]/i

let ids = 0

/** Chat drawer: ask the agent for a change, watch its progress, undo, history, reset. */
export function MorphkitChat({
  agentUrl = '/agent',
  appId,
  title = 'Customize this page',
  examples = [],
  defaultOpen = false,
  launcherLabel = 'Customize',
  pushContent = true,
}: MorphkitChatProps) {
  useMorphkitUiStyles()
  const engine = useMorphkit()
  const state = useMorphkitState()
  const [open, setOpen] = useState(defaultOpen)
  const [text, setText] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [history, setHistory] = useState<Snapshot[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const body = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  const toast = useCallback((t: string, tone: Toast['tone'] = 'ok') => {
    const id = ++ids
    setToasts((all) => [...all, { id, text: t, tone }])
    setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), 3500)
  }, [])

  // Preload esbuild-wasm and the Tailwind compiler as soon as the chat opens (DECISIONS item 4).
  useEffect(() => {
    if (open) void engine.warmup().catch(() => undefined)
  }, [open, engine])

  useEffect(() => {
    if (!open || !pushContent || window.innerWidth < 900) return
    const root = document.documentElement
    const prev = root.style.paddingRight
    root.style.paddingRight = '400px'
    return () => {
      root.style.paddingRight = prev
    }
  }, [open, pushContent])

  useEffect(() => {
    if (!showHistory) return
    let alive = true
    void engine.history(30).then((h) => alive && setHistory(h))
    return () => {
      alive = false
    }
  }, [showHistory, engine, state.head?.id])

  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight })
  }, [turns])

  const update = (id: number, patch: Partial<Turn> | ((t: Turn) => Partial<Turn>)) =>
    setTurns((all) => all.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)))

  const addStep = (id: number, p: AgentProgress) =>
    update(id, (t) => {
      if (p.type === 'check') return { steps: [...t.steps, { text: p.text, tone: p.ok ? 'good' : 'bad' }] }
      if (p.type === 'model' && t.steps.at(-1)?.text === p.text) return {}
      return { steps: [...t.steps, { text: p.text }] }
    })

  const run = async (request: string, migrate = false) => {
    const trimmed = request.trim()
    if (!trimmed || busy) return
    const id = ++ids
    setTurns((all) => [...all, { id, request: trimmed, status: 'running', steps: [] }])
    setBusy(true)
    const started = performance.now()
    try {
      const target = PANEL_TAG.exec(trimmed)?.[1]
      // A migration rewrites the new release's files with the user's old customizations applied.
      const migration = migrate ? await engine.migrationInput() : null
      const from = migration ? engine.originalFiles() : undefined
      const payload = engine.agentRequest(trimmed, { ...(appId ? { appId } : {}), ...(target ? { target } : {}), ...(migration ? { migration, files: from } : {}) })
      const result = await callAgent(agentUrl, payload, (p) => addStep(id, p))
      const agentMs = performance.now() - started
      update(id, { result, summary: result.summary })

      if (result.verdict === 'needs-backend') {
        update(id, { status: 'needs-backend' })
        toast('Sent to the administrator', 'admin')
        return
      }
      if (result.verdict !== 'ok') {
        update(id, { status: 'failed' })
        return
      }
      const changed = Object.keys(result.files).length + result.deleted.length
      if (changed === 0 && !from) {
        update(id, { status: 'nothing' })
        return
      }
      engine.draft.start(trimmed, from)
      for (const [path, source] of Object.entries(result.files)) engine.draft.write(path, source)
      for (const path of result.deleted) engine.draft.remove(path)
      const commitStarted = performance.now()
      try {
        const snapshot = await engine.draft.commit('agent', result.requestId ? { requestId: result.requestId } : {})
        // wait for React to paint the swapped modules before stopping the clock
        await new Promise((r) => requestAnimationFrame(() => r(null)))
        const now = performance.now()
        update(id, { status: 'applied', timing: { totalMs: now - started, agentMs, commitMs: now - commitStarted } })
        toast('Applied')
        if (result.requestId) void engine.linkRequest(result.requestId, { snapshotId: snapshot.id, status: 'applied' }).catch(() => undefined)
      } catch (e) {
        const errors = e instanceof CommitRejectedError ? e.errors : [{ file: '', line: 0, column: 0, text: (e as Error).message }]
        update(id, { status: 'rejected', errors })
        engine.draft.discard()
        toast('The change did not compile in the browser; nothing was applied', 'bad')
        if (result.requestId) {
          const snapshotId = e instanceof CommitRejectedError ? e.snapshot.id : undefined
          void engine.linkRequest(result.requestId, { status: 'rejected', ...(snapshotId ? { snapshotId } : {}), error: errors.map((x) => x.text).join('; ') }).catch(() => undefined)
        }
      }
    } catch (e) {
      update(id, { status: 'failed', summary: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const send = () => {
    const t = text
    setText('')
    void run(t)
  }

  const nav = async (label: string, op: () => Promise<Snapshot | null>) => {
    engine.draft.discard()
    const s = await op()
    toast(s ? label : `${label}: nothing to do`)
  }

  const head = state.head
  return (
    <div className="mk-root" data-morphkit-ui-layer="">
      {state.stale && (
        <div className="mk-stale" role="status" data-testid="mk-stale">
          <span>The app was updated since you customized it. Your version may be out of date.</span>
          <button type="button" className="mk-btn" data-testid="mk-stale-reset" disabled={busy} onClick={() => void nav('Reset to the new version', () => engine.reset())}>
            Reset my changes
          </button>
          <button
            type="button"
            className="mk-btn"
            data-testid="mk-stale-migrate"
            disabled={busy}
            onClick={() => {
              setOpen(true)
              void run('Carry my customizations over to the new version of the app', true)
            }}
          >
            Ask the agent to carry them over
          </button>
        </div>
      )}

      {!open && (
        <button type="button" className="mk-launch" data-testid="mk-chat-open" onClick={() => setOpen(true)}>
          <span className="mk-dot" />
          {launcherLabel}
        </button>
      )}

      {open && (
        <aside className="mk-drawer" aria-label="morphkit chat" data-testid="mk-chat">
          <div className="mk-head">
            <div>
              <div className="mk-title">{title}</div>
              <div className="mk-sub">
                Your personal version · {head && head.parentId ? `${head.author} edit, ${new Date(head.createdAt).toLocaleTimeString()}` : 'original'}
              </div>
            </div>
            <button type="button" className="mk-icon" aria-label="Close" data-testid="mk-chat-close" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>

          <div className="mk-body" ref={body} data-testid="mk-chat-body">
            {turns.length === 0 && (
              <div className="mk-empty">
                Describe what you want to change on this page. Only your view changes; you can undo any time.
                {examples.length > 0 && (
                  <ul>
                    {examples.map((ex) => (
                      <li key={ex}>
                        <button type="button" className="mk-btn" style={{ border: 0, padding: 0, textAlign: 'left', color: '#5b21b6' }} onClick={() => setText(ex)}>
                          {ex}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {turns.map((t) => (
              <TurnView key={t.id} turn={t} />
            ))}
          </div>

          <div className="mk-foot">
            {showHistory && (
              <ol className="mk-history" data-testid="mk-history">
                {history.map((s) => (
                  <li key={s.id} className={`${s.id === head?.id ? 'mk-cur' : ''} ${s.status === 'rejected' ? 'mk-rej' : ''}`}>
                    <span style={{ color: '#64748b', minWidth: 54 }}>{new Date(s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    <span style={{ flex: 1 }}>
                      {s.author === 'base' ? 'Original version' : s.message}
                      {s.status === 'rejected' && ' (rejected)'}
                    </span>
                    {s.id === head?.id && <strong>current</strong>}
                  </li>
                ))}
              </ol>
            )}
            <textarea
              ref={input}
              className="mk-input"
              data-testid="mk-chat-input"
              placeholder="e.g. show the phone and city in the customer card"
              value={text}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            <div className="mk-row">
              <button type="button" className={`mk-btn ${picking ? 'mk-on' : ''}`} data-testid="mk-chat-pick" disabled={busy} onClick={() => setPicking(true)}>
                Point at a panel
              </button>
              <button type="button" className="mk-btn mk-primary" data-testid="mk-chat-send" disabled={busy || !text.trim()} onClick={send}>
                {busy ? 'Working…' : 'Send'}
              </button>
            </div>
            <div className="mk-row">
              <button type="button" className="mk-btn" data-testid="mk-chat-undo" disabled={busy || !state.canUndo} onClick={() => void nav('Undone', () => engine.undo())}>
                Undo last change
              </button>
              <button type="button" className={`mk-btn ${showHistory ? 'mk-on' : ''}`} data-testid="mk-chat-history" onClick={() => setShowHistory((v) => !v)}>
                History
              </button>
              <button type="button" className="mk-btn" data-testid="mk-chat-reset" disabled={busy || !(head?.parentId || state.stale)} onClick={() => void nav('Reset to the original', () => engine.reset())}>
                Reset to original
              </button>
            </div>
          </div>
        </aside>
      )}

      {picking && (
        <ElementPicker
          onCancel={() => setPicking(false)}
          onPick={(id) => {
            setPicking(false)
            setText((t) => `[panel: ${id}] ${t.replace(PANEL_TAG, '').trimStart()}`)
            input.current?.focus()
          }}
        />
      )}

      <div className="mk-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`mk-toast ${t.tone === 'bad' ? 'mk-t-bad' : t.tone === 'admin' ? 'mk-t-admin' : ''}`} data-testid="mk-toast">
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}

const BADGE: Record<TurnStatus, [string, string]> = {
  running: ['Working', 'mk-b-run'],
  applied: ['Applied', 'mk-b-ok'],
  nothing: ['No change needed', 'mk-b-ok'],
  'needs-backend': ['Sent to admin', 'mk-b-admin'],
  failed: ['Not done', 'mk-b-bad'],
  rejected: ['Did not compile', 'mk-b-bad'],
}

function TurnView({ turn }: { turn: Turn }) {
  const [label, cls] = BADGE[turn.status]
  const cost = turn.result?.usage.reduce((s, u) => s + (u.costUsd ?? 0), 0) ?? 0
  return (
    <div className="mk-turn" data-testid="mk-chat-turn" data-status={turn.status} data-total-ms={turn.timing ? Math.round(turn.timing.totalMs) : undefined}>
      <div className="mk-req">{turn.request}</div>
      <div className="mk-resp">
        <span className={`mk-badge ${cls}`}>{label}</span>
        <ul className="mk-steps" data-testid="mk-chat-steps">
          {turn.steps.map((s, i) => (
            <li key={i} className={s.tone === 'good' ? 'mk-good' : s.tone === 'bad' ? 'mk-bad' : undefined}>
              {s.text}
            </li>
          ))}
        </ul>
        {turn.summary && (
          <div className="mk-summary" data-testid="mk-chat-summary">
            {turn.summary}
          </div>
        )}
        {turn.errors && (
          <ul className="mk-errors">
            {turn.errors.map((e, i) => (
              <li key={i}>
                {e.file}
                {e.line ? `:${e.line}:${e.column}` : ''} {e.text}
              </li>
            ))}
          </ul>
        )}
        {turn.result && turn.status !== 'running' && (
          <div className="mk-meta">
            {turn.timing ? `${(turn.timing.totalMs / 1000).toFixed(1)} s to apply · ` : ''}
            {turn.result.modelCalls} model call{turn.result.modelCalls === 1 ? '' : 's'} · {turn.result.log.length} tool calls
            {cost > 0 ? ` · $${cost.toFixed(4)}` : ''}
          </div>
        )}
      </div>
    </div>
  )
}
