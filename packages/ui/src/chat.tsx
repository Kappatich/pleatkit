import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CommitRejectedError, MAX_AGENT_IMAGE_BYTES, MAX_AGENT_IMAGES, useMorphkit, useMorphkitState, type AgentResult, type Locale, type Snapshot } from '@morphkit/runtime'
import { addImages, imageFiles, panelDomSnapshot, prepareImage, type PendingImage } from './attachments.js'
import { translator, type Translate, type UiKey } from './i18n.js'
import { ElementPicker } from './picker.js'
import { callAgent } from './sse.js'
import { addStep, visibleSteps, type Step } from './steps.js'
import { useMorphkitUiStyles } from './styles.js'

export interface MorphkitChatProps {
  /** Base URL of @morphkit/agent, e.g. `/agent` behind the app's proxy. */
  agentUrl?: string
  /** Store namespace sent to the agent for its request log. */
  appId?: string
  /** Interface language of the chat and of the agent's progress lines and summaries. Default `en`. */
  locale?: Locale
  /** Overrides the localized title. */
  title?: string
  /** Example requests shown in an empty chat. */
  examples?: string[]
  defaultOpen?: boolean
  /** Overrides the localized launcher label. */
  launcherLabel?: string
  /** Shift the page left while the drawer is open so the panels being changed stay visible. Default true. */
  pushContent?: boolean
}

type TurnStatus = 'running' | 'applied' | 'nothing' | 'needs-backend' | 'failed' | 'rejected'

interface Turn {
  id: number
  request: string
  /** Thumbnails of the screenshots sent with the request. */
  images?: string[]
  status: TurnStatus
  steps: Step[]
  summary?: string
  /** Applied under `moderation: 'review'`: an administrator will look at it. */
  review?: boolean
  /** Snapshot this turn produced, so its Undo button acts only while it is the current version. */
  snapshotId?: string
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
  locale = 'en',
  title,
  examples = [],
  defaultOpen = false,
  launcherLabel,
  pushContent = true,
}: MorphkitChatProps) {
  useMorphkitUiStyles()
  const tr = useMemo(() => translator(locale), [locale])
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
  const [warm, setWarm] = useState(false)
  const [images, setImages] = useState<PendingImage[]>([])
  const [dragging, setDragging] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  const toast = useCallback((t: string, tone: Toast['tone'] = 'ok') => {
    const id = ++ids
    setToasts((all) => [...all, { id, text: t, tone }])
    setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), 3500)
  }, [])

  // Preload esbuild-wasm and the Tailwind compiler as soon as the chat opens (DECISIONS item 4).
  useEffect(() => {
    if (open)
      void engine.warmup().then(
        () => setWarm(true),
        () => undefined,
      )
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

  /** Screenshots pasted or dropped into the chat (vision input), within the per-request limits. */
  const attach = async (files: File[]) => {
    if (files.length === 0) return
    const prepared = await Promise.all(files.map((f) => prepareImage(f).catch(() => null)))
    setImages((current) => {
      const { images: next, dropped } = addImages(current, prepared.filter((p): p is PendingImage => p !== null))
      if (dropped) toast(tr('chat.attach.limit', { n: MAX_AGENT_IMAGES, mb: MAX_AGENT_IMAGE_BYTES / 1024 / 1024 }), 'bad')
      return next
    })
  }

  const run = async (request: string, migrate = false, attached: PendingImage[] = []) => {
    const trimmed = request.trim()
    if (!trimmed || busy) return
    const id = ++ids
    setTurns((all) => [...all, { id, request: trimmed, status: 'running', steps: [], ...(attached.length ? { images: attached.map((i) => i.preview) } : {}) }])
    setBusy(true)
    const started = performance.now()
    try {
      const target = PANEL_TAG.exec(trimmed)?.[1]
      // A migration rewrites the new release's files with the user's old customizations applied.
      const migration = migrate ? await engine.migrationInput() : null
      const from = migration ? engine.originalFiles() : undefined
      // what the pointed panel looks like right now, as data for the agent
      const targetDom = target ? panelDomSnapshot(target) : null
      const payload = engine.agentRequest(trimmed, {
        locale,
        ...(appId ? { appId } : {}),
        ...(target ? { target } : {}),
        ...(targetDom ? { targetDom } : {}),
        ...(attached.length ? { images: attached.map(({ mediaType, data, name }) => ({ mediaType, data, ...(name ? { name } : {}) })) } : {}),
        ...(migration ? { migration, files: from } : {}),
      })
      const result = await callAgent(agentUrl, payload, (p) => update(id, (t) => ({ steps: addStep(t.steps, p) })))
      const agentMs = performance.now() - started
      // the agent's last "Thinking" line is over once the result is in
      update(id, (t) => ({ result, summary: plain(result.summary), steps: t.steps.filter((s) => !s.transient) }))

      if (result.verdict === 'needs-backend') {
        update(id, { status: 'needs-backend' })
        toast(tr('toast.admin'), 'admin')
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
        update(id, { status: 'applied', snapshotId: snapshot.id, timing: { totalMs: now - started, agentMs, commitMs: now - commitStarted } })
        if (!result.requestId) {
          toast(tr('toast.applied'))
          return
        }
        // under `moderation: 'review'` store-server marks the edit for the admin's review (DECISIONS item 15)
        const link = await engine.linkRequest(result.requestId, { snapshotId: snapshot.id, status: 'applied' }).catch(() => null)
        const review = link?.status === 'pending-review'
        if (review) update(id, { review: true })
        toast(tr(review ? 'toast.appliedReview' : 'toast.applied'))
      } catch (e) {
        const errors = e instanceof CommitRejectedError ? e.errors : [{ file: '', line: 0, column: 0, text: (e as Error).message }]
        // the details go to the admin's request log, not to the user
        update(id, { status: 'rejected', summary: tr('chat.rejectedSummary') })
        engine.draft.discard()
        toast(tr('toast.rejected'), 'bad')
        if (result.requestId) {
          const snapshotId = e instanceof CommitRejectedError ? e.snapshot.id : undefined
          void engine.linkRequest(result.requestId, { status: 'rejected', ...(snapshotId ? { snapshotId } : {}), error: errors.map((x) => x.text).join('; ') }).catch(() => undefined)
        }
      }
    } catch (e) {
      console.warn('[morphkit] agent request failed', e)
      update(id, (t) => ({ status: 'failed', summary: tr('chat.failedSummary'), steps: t.steps.filter((s) => !s.transient) }))
    } finally {
      setBusy(false)
    }
  }

  const send = () => {
    const t = text
    const attached = images
    setText('')
    setImages([])
    void run(t, false, attached)
  }

  const nav = async (label: string, op: () => Promise<Snapshot | null>) => {
    engine.draft.discard()
    const s = await op()
    toast(s ? label : tr('toast.nothing', { label }))
  }

  const head = state.head
  return (
    <div className="mk-root" data-morphkit-ui-layer="" lang={locale}>
      {state.stale && (
        <div className="mk-stale" role="status" data-testid="mk-stale">
          <span>{tr('chat.stale')}</span>
          <button type="button" className="mk-btn" data-testid="mk-stale-reset" disabled={busy} onClick={() => void nav(tr('toast.resetNew'), () => engine.reset())}>
            {tr('chat.stale.reset')}
          </button>
          <button
            type="button"
            className="mk-btn"
            data-testid="mk-stale-migrate"
            disabled={busy}
            onClick={() => {
              setOpen(true)
              void run(tr('chat.migrateRequest'), true)
            }}
          >
            {tr('chat.stale.migrate')}
          </button>
        </div>
      )}

      {!open && (
        <button type="button" className="mk-launch" data-testid="mk-chat-open" onClick={() => setOpen(true)}>
          <span className="mk-dot" />
          {launcherLabel ?? tr('chat.launcher')}
        </button>
      )}

      {open && (
        <aside
          className={`mk-drawer ${dragging ? 'mk-dragging' : ''}`}
          aria-label="morphkit chat"
          data-testid="mk-chat"
          data-warm={warm}
          onDragOver={(e) => {
            if (!Array.from(e.dataTransfer.types).includes('Files')) return
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDragging(false)
          }}
          onDrop={(e) => {
            const files = imageFiles(e.dataTransfer)
            setDragging(false)
            if (files.length === 0) return
            e.preventDefault()
            void attach(files)
          }}
        >
          {dragging && <div className="mk-dropzone">{tr('chat.attach.drop')}</div>}
          <div className="mk-head">
            <div>
              <div className="mk-title">{title ?? tr('chat.title')}</div>
              <div className="mk-sub">
                {tr('chat.version', {
                  what: head && head.parentId ? tr('chat.version.edit', { author: head.author, time: new Date(head.createdAt).toLocaleTimeString(locale) }) : tr('chat.version.original'),
                })}
              </div>
            </div>
            <button type="button" className="mk-icon" aria-label={tr('chat.close')} data-testid="mk-chat-close" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>

          <div className="mk-body" ref={body} data-testid="mk-chat-body">
            {turns.length === 0 && (
              <div className="mk-empty">
                {tr('chat.empty')}
                {examples.length > 0 && (
                  <ul>
                    {examples.map((ex) => (
                      <li key={ex}>
                        <button type="button" className="mk-btn mk-example" onClick={() => setText(ex)}>
                          {ex}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {turns.map((t) => (
              <TurnView
                key={t.id}
                turn={t}
                tr={tr}
                canUndo={!busy && t.snapshotId !== undefined && t.snapshotId === head?.id && state.canUndo}
                onUndo={() => void nav(tr('toast.undone'), () => engine.undo())}
                onHistory={() => setShowHistory(true)}
              />
            ))}
          </div>

          <div className="mk-foot">
            {showHistory && (
              <ol className="mk-history" data-testid="mk-history">
                {history.map((s) => (
                  <li key={s.id} className={`${s.id === head?.id ? 'mk-cur' : ''} ${s.status === 'rejected' ? 'mk-rej' : ''}`}>
                    <span style={{ color: '#64748b', minWidth: 54 }}>{new Date(s.createdAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</span>
                    <span style={{ flex: 1 }}>
                      {s.author === 'base' ? tr('chat.history.original') : s.message}
                      {s.status === 'rejected' && tr('chat.history.rejected')}
                    </span>
                    {s.id === head?.id && <strong>{tr('chat.history.current')}</strong>}
                  </li>
                ))}
              </ol>
            )}
            {images.length > 0 && (
              <div className="mk-thumbs" data-testid="mk-chat-images">
                {images.map((img) => (
                  <span key={img.id} className="mk-thumb">
                    <img src={img.preview} alt={img.name ?? ''} />
                    <button type="button" aria-label={tr('chat.attach.remove')} data-testid="mk-chat-image-remove" onClick={() => setImages((all) => all.filter((x) => x.id !== img.id))}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={input}
              className="mk-input"
              title={tr('chat.attach.hint')}
              onPaste={(e) => {
                const files = imageFiles(e.clipboardData)
                if (files.length === 0) return
                // a screenshot, not text: keep it out of the text field
                if (!e.clipboardData.getData('text/plain')) e.preventDefault()
                void attach(files)
              }}
              data-testid="mk-chat-input"
              placeholder={tr('chat.placeholder')}
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
                {tr('chat.pick')}
              </button>
              <button type="button" className="mk-btn mk-primary" data-testid="mk-chat-send" disabled={busy || !text.trim()} onClick={send}>
                {busy ? tr('chat.working') : tr('chat.send')}
              </button>
            </div>
            <div className="mk-row">
              <button type="button" className="mk-btn" data-testid="mk-chat-undo" disabled={busy || !state.canUndo} onClick={() => void nav(tr('toast.undone'), () => engine.undo())}>
                {tr('chat.undoLast')}
              </button>
              <button type="button" className={`mk-btn ${showHistory ? 'mk-on' : ''}`} data-testid="mk-chat-history" onClick={() => setShowHistory((v) => !v)}>
                {tr('chat.history')}
              </button>
              <button
                type="button"
                className="mk-btn"
                data-testid="mk-chat-reset"
                disabled={busy || !(head?.parentId || state.stale)}
                onClick={() => void nav(tr('toast.resetOriginal'), () => engine.reset())}
              >
                {tr('chat.reset')}
              </button>
            </div>
          </div>
        </aside>
      )}

      {picking && (
        <ElementPicker
          hint={tr('chat.pickHint')}
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

const BADGE: Record<TurnStatus, [UiKey, string]> = {
  running: ['badge.running', 'mk-b-run'],
  applied: ['badge.applied', 'mk-b-ok'],
  nothing: ['badge.nothing', 'mk-b-ok'],
  'needs-backend': ['badge.needs-backend', 'mk-b-admin'],
  failed: ['badge.failed', 'mk-b-bad'],
  rejected: ['badge.rejected', 'mk-b-bad'],
}

/** Model summaries are meant for the user; strip anything that still looks like code. */
function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .trim()
}

function TurnView({ turn, tr, canUndo, onUndo, onHistory }: { turn: Turn; tr: Translate; canUndo: boolean; onUndo: () => void; onHistory: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [labelKey, cls] = BADGE[turn.status]
  const cost = turn.result?.usage.reduce((s, u) => s + (u.costUsd ?? 0), 0) ?? 0
  const { shown, hidden } = visibleSteps(turn.steps, expanded)
  return (
    <div
      className="mk-turn"
      data-testid="mk-chat-turn"
      data-status={turn.status}
      data-review={turn.review ? 'pending' : undefined}
      data-total-ms={turn.timing ? Math.round(turn.timing.totalMs) : undefined}
      data-agent-ms={turn.timing ? Math.round(turn.timing.agentMs) : undefined}
      data-commit-ms={turn.timing ? Math.round(turn.timing.commitMs) : undefined}
      data-model-calls={turn.result?.modelCalls}
      data-cost-usd={turn.result ? cost.toFixed(6) : undefined}
      data-usage={turn.result ? JSON.stringify(turn.result.usage) : undefined}
    >
      <div className="mk-req">
        {turn.request}
        {turn.images && (
          <span className="mk-req-thumbs" data-testid="mk-turn-images" aria-label={tr('chat.attach.count', { n: turn.images.length })}>
            {turn.images.map((src, i) => (
              <img key={i} src={src} alt="" />
            ))}
          </span>
        )}
      </div>
      <div className="mk-resp">
        <span className={`mk-badge ${cls}`}>{tr(labelKey)}</span>
        {(hidden > 0 || expanded) && (
          <button type="button" className="mk-details" data-testid="mk-chat-steps-toggle" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
            {expanded ? tr('chat.details.less') : tr('chat.details.more', { n: turn.steps.length })}
          </button>
        )}
        <ul className="mk-steps" data-testid="mk-chat-steps" data-hidden={hidden}>
          {shown.map((s, i) => (
            <li key={i} className={s.tone === 'good' ? 'mk-good' : s.tone === 'bad' ? 'mk-bad' : s.transient ? 'mk-transient' : undefined}>
              {s.text}
              {s.count && s.count > 1 ? <span className="mk-count">×{s.count}</span> : null}
            </li>
          ))}
        </ul>
        {turn.summary && (
          <div className="mk-summary" data-testid="mk-chat-summary">
            {turn.summary}
          </div>
        )}
        {turn.review && (
          <div className="mk-meta" data-testid="mk-chat-review">
            {tr('chat.review')}
          </div>
        )}
        {turn.status === 'applied' && (
          <div className="mk-row" style={{ marginTop: 6 }}>
            <button type="button" className="mk-btn" data-testid="mk-turn-undo" disabled={!canUndo} onClick={onUndo}>
              {tr('chat.undo')}
            </button>
            <button type="button" className="mk-btn" data-testid="mk-turn-history" onClick={onHistory}>
              {tr('chat.history')}
            </button>
            {turn.timing && <span className="mk-meta">{tr('chat.appliedIn', { seconds: (turn.timing.totalMs / 1000).toFixed(1) })}</span>}
          </div>
        )}
      </div>
    </div>
  )
}
