import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { APPLY_VERDICTS, CommitRejectedError, HeadConflictError, MAX_AGENT_IMAGE_BYTES, MAX_AGENT_IMAGES, PleatkitUiRoot, usePleatkit, usePleatkitState, type AgentResult, type Locale, type Snapshot } from '@pleatkit/runtime'
import { addImages, imageFiles, panelDomSnapshot, prepareImage, type PendingImage } from './attachments.js'
import { translator, type Translate } from './i18n.js'
import { ElementPicker } from './picker.js'
import { callAgent } from './sse.js'
import { addStep, type Step } from './steps.js'
import { usePleatkitUiStyles } from './styles.js'

export interface PleatkitChatProps {
  /** Base URL of @pleatkit/agent, e.g. `/agent` behind the app's proxy. */
  agentUrl?: string
  /** Store namespace sent to the agent for its request log. */
  appId?: string
  /** Interface language of the chat and of the agent's progress lines and summaries. Default `en`. */
  locale?: Locale
  /** Overrides the localized title. */
  title?: string
  /** Example requests shown in an empty chat, as chips above the composer. */
  examples?: string[]
  defaultOpen?: boolean
  /** Overrides the localized launcher label. */
  launcherLabel?: string
  /** Shift the page left while the drawer is open so the panels being changed stay visible. Default true. */
  pushContent?: boolean
  /**
   * The user token for the agent server (production, V1 A1): the same short-lived JWT your backend mints for
   * store-server, or a function returning a fresh one. Sent as `Authorization: Bearer …`.
   */
  token?: string | (() => string | Promise<string>)
  /** Called when the agent server answers 401 (the token expired, brainstorm 05 #19): return a fresh token. */
  onAuthExpired?: () => string | null | undefined | Promise<string | null | undefined>
  /**
   * Render the drawer in a shadow root (code review 06 item 9), so the CSS of an edit cannot hide or restyle it.
   * Default true; false renders in place.
   */
  shadow?: boolean
}

type TurnStatus = 'running' | 'applied' | 'nothing' | 'needs-backend' | 'failed' | 'rejected' | 'clarify' | 'refused'

interface Turn {
  id: number
  request: string
  /** The panel the user pointed at, shown as a chip on the request. */
  target?: string
  /** What the bubble shows when it differs from the request (the answer to a clarifying question). */
  display?: string
  /** The agent asked one question before changing anything; `answered` once the user picked an answer. */
  clarify?: { question: string; options: string[]; answered?: string }
  /** The original request and screenshots, to send again with the answer. */
  origin?: { request: string; attached: PendingImage[] }
  /** Thumbnails of the screenshots sent with the request. */
  images?: string[]
  status: TurnStatus
  steps: Step[]
  summary?: string
  /** verdict `partial`: what went to the admin (the backend part), shown under the summary */
  note?: string
  /** Applied under `moderation: 'review'`: an administrator will look at it. */
  review?: boolean
  /** Snapshot this turn produced; the summary is struck through while it is undone. */
  snapshotId?: string
  /** Send → re-render, and the agent's own share. Kept on the DOM for the admin and the tests, not shown. */
  timing?: { totalMs: number; agentMs: number; commitMs: number }
  result?: AgentResult
  startedAt: number
}

interface Toast {
  id: number
  text: string
  tone: 'ok' | 'bad' | 'admin'
  /** One undo-style action on the toast (brainstorm 14 §1). */
  action?: { label: string; run: () => void }
}

const PANEL_TAG = /\[panel:\s*([\w./-]+)\]/i

let ids = 0

const Icon = {
  undo: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7l-5 5 5 5M4 12h11a5 5 0 0 1 0 10" /></svg>,
  redo: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 7l5 5-5 5M20 12H9a5 5 0 0 0 0 10" /></svg>,
  close: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>,
  send: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>,
  stop: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" /></svg>,
  pick: <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg>,
  clip: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.5l-8.5 8.5a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8" /></svg>,
}

/** Chat drawer: ask the agent for a change, watch one live progress line, undo with one gesture, open the version timetable. */
export function PleatkitChat({
  agentUrl = '/agent',
  appId,
  locale = 'en',
  title,
  examples = [],
  defaultOpen = false,
  launcherLabel,
  pushContent = true,
  token,
  onAuthExpired,
  shadow = true,
}: PleatkitChatProps) {
  usePleatkitUiStyles()
  const tr = useMemo(() => translator(locale), [locale])
  const engine = usePleatkit()
  const state = usePleatkitState()
  const [open, setOpen] = useState(defaultOpen)
  const [text, setText] = useState('')
  const [target, setTarget] = useState<string | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [history, setHistory] = useState<Snapshot[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const [warm, setWarm] = useState(false)
  const [images, setImages] = useState<PendingImage[]>([])
  const [dragging, setDragging] = useState(false)
  const [tick, setTick] = useState(0)
  const body = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const drawer = useRef<HTMLElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  /** The running request; Stop (and leaving the page) aborts it, and the agent server stops the model. */
  const running = useRef<AbortController | null>(null)
  useEffect(() => () => running.current?.abort(), [])
  // Another user signed in (the provider keeps the host's tree mounted, code review 06 item 11): the chat of the
  // previous user must not stay on screen, and their running request is cancelled.
  const userKey = `${engine.namespace}\0${engine.userId}`
  const firstUser = useRef(userKey)
  useEffect(() => {
    if (firstUser.current === userKey) return
    firstUser.current = userKey
    running.current?.abort()
    setTurns([])
    setImages([])
    setHistory([])
    setShowHistory(false)
    setText('')
    setTarget(null)
    setOpen(defaultOpen)
  }, [userKey, defaultOpen])

  const toast = useCallback((t: string, tone: Toast['tone'] = 'ok', action?: Toast['action']) => {
    const id = ++ids
    setToasts((all) => [...all, { id, text: t, tone, ...(action ? { action } : {}) }])
    setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), action ? 5000 : 3000)
  }, [])

  // Preload the compilers as soon as the chat opens (DECISIONS item 4).
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
    root.style.paddingRight = '420px'
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

  // the live line shows elapsed seconds while the agent works
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [busy])

  // the composer grows from one to six lines
  useEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(160, Math.max(44, el.scrollHeight))}px`
  }, [text, open])

  const update = (id: number, patch: Partial<Turn> | ((t: Turn) => Partial<Turn>)) =>
    setTurns((all) => all.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)))

  /** Screenshots pasted, dropped or picked into the chat (vision input), within the per-request limits. */
  const attach = async (files: File[]) => {
    if (files.length === 0) return
    const prepared = await Promise.all(files.map((f) => prepareImage(f).catch(() => null)))
    setImages((current) => {
      const { images: next, dropped } = addImages(current, prepared.filter((p): p is PendingImage => p !== null))
      if (dropped) toast(tr('chat.attach.limit', { n: MAX_AGENT_IMAGES, mb: MAX_AGENT_IMAGE_BYTES / 1024 / 1024 }), 'bad')
      return next
    })
  }

  const run = async (request: string, migrate = false, attached: PendingImage[] = [], clarification?: { question: string; answer: string }) => {
    const trimmed = request.trim()
    if (!trimmed || busy) return
    const id = ++ids
    const panel = PANEL_TAG.exec(trimmed)?.[1]
    setTurns((all) => [
      ...all,
      {
        id,
        request: trimmed,
        ...(panel ? { target: panel } : {}),
        ...(clarification ? { display: clarification.answer } : {}),
        status: 'running',
        steps: [],
        startedAt: Date.now(),
        ...(attached.length && !clarification ? { images: attached.map((i) => i.preview) } : {}),
      },
    ])
    setBusy(true)
    const started = performance.now()
    const abort = new AbortController()
    running.current = abort
    try {
      // A migration rewrites the new release's files with the user's old customizations applied.
      const migration = migrate ? await engine.migrationInput() : null
      const from = migration ? engine.originalFiles() : undefined
      // what the pointed panel looks like right now, as data for the agent
      // structure only unless the app allows text (sendDomText); private subtrees never (brainstorm 05 #3)
      const targetDom = panel ? panelDomSnapshot(panel, document, undefined, engine.config.sendDomText === true) : null
      const payload = engine.agentRequest(trimmed, {
        locale,
        ...(appId ? { appId } : {}),
        ...(panel ? { target: panel } : {}),
        ...(targetDom ? { targetDom } : {}),
        ...(clarification ? { clarification } : {}),
        ...(attached.length ? { images: attached.map(({ mediaType, data, name }) => ({ mediaType, data, ...(name ? { name } : {}) })) } : {}),
        ...(migration ? { migration, files: from } : {}),
      })
      const bearer = typeof token === 'function' ? await token() : token
      const result = await callAgent(agentUrl, payload, (p) => update(id, (t) => ({ steps: addStep(t.steps, p) })), {
        headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), 'idempotency-key': `run-${engine.userId}-${Date.now().toString(36)}-${id}-${Math.random().toString(36).slice(2, 8)}` },
        signal: abort.signal,
        ...(onAuthExpired ? { onAuthExpired } : {}),
      })
      const agentMs = performance.now() - started
      // the agent's last "Thinking" line is over once the result is in
      update(id, (t) => ({ result, summary: plain(result.summary), steps: t.steps.filter((s) => !s.transient) }))

      if (result.verdict === 'clarify' && result.clarify) {
        // one question with buttons; the answer re-sends the same request (the agent never asks twice)
        update(id, { status: 'clarify', clarify: result.clarify, origin: { request: trimmed, attached } })
        return
      }
      if (result.verdict === 'needs-backend') {
        update(id, { status: 'needs-backend' })
        if (!open) toast(tr('toast.admin'), 'admin')
        return
      }
      if (result.verdict === 'refused' || result.verdict === 'declined' || result.verdict === 'not-editable') {
        // off-topic, over the quota, switched off, declined or about a part that is not open for edits
        update(id, { status: 'refused' })
        return
      }
      // `partial`: the UI part is applied like `ok`, the rest went to the admin with the request
      if (!APPLY_VERDICTS.includes(result.verdict)) {
        // three causes a user can act on differently (brainstorm 17 §B6): busy, too big, the app's own zone fails its check
        const stop = result.stopReason
        const summary =
          stop === 'rate-limited' ? tr('chat.busySummary')
          : stop === 'cost' || stop === 'calls' || stop === 'timeout' || stop === 'output-tokens' ? tr('chat.limitSummary')
          : /release|zone/i.test(result.error ?? '') ? tr('chat.zoneSummary')
          : tr('chat.failedSummary')
        // a summary the agent already gave (e.g. the scripted provider's hint) wins over the generic cause
        update(id, (t) => ({ status: 'failed', summary: t.summary || result.summary || summary }))
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
        // compile: 'server': the agent already compiled and signed this snapshot, the commit only downloads it
        // only on top of the head the request was made from (code review 06 item 6)
        const expectedHeadId = result.expectedHeadId !== undefined ? result.expectedHeadId : payload.expectedHeadId
        const snapshot = await engine.draft.commit('agent', {
          ...(result.requestId ? { requestId: result.requestId } : {}),
          ...(result.bundle ? { bundle: result.bundle } : {}),
          ...(expectedHeadId !== undefined ? { expectedHeadId } : {}),
        })
        // wait for React to paint the swapped modules before stopping the clock
        await new Promise((r) => requestAnimationFrame(() => r(null)))
        const now = performance.now()
        update(id, { status: 'applied', snapshotId: snapshot.id, timing: { totalMs: now - started, agentMs, commitMs: now - commitStarted } })
        if (result.verdict === 'partial') update(id, { review: false, ...(result.backendNote ? { note: result.backendNote } : {}) })
        // the result itself is the confirmation; a toast only when the drawer is not on screen (brainstorm 14)
        if (!open) toast(tr('toast.applied'))
        if (!result.requestId) return
        // under `moderation: 'review'` store-server marks the edit for the admin's review (DECISIONS item 15)
        const link = await engine.linkRequest(result.requestId, { snapshotId: snapshot.id, status: 'applied' }).catch(() => null)
        if (link?.status === 'pending-review') update(id, { review: true })
      } catch (e) {
        if (e instanceof HeadConflictError) {
          engine.draft.discard()
          update(id, { status: 'failed', summary: tr('chat.conflictSummary') })
          if (result.requestId) void engine.linkRequest(result.requestId, { status: 'failed', error: 'head moved during the run (another tab or an admin rollback)' }).catch(() => undefined)
          return
        }
        const errors = e instanceof CommitRejectedError ? e.errors : [{ file: '', line: 0, column: 0, text: (e as Error).message }]
        // the details go to the admin's request log, not to the user
        update(id, { status: 'rejected', summary: tr('chat.rejectedSummary') })
        engine.draft.discard()
        if (result.requestId) {
          const snapshotId = e instanceof CommitRejectedError ? e.snapshot.id : undefined
          void engine.linkRequest(result.requestId, { status: 'rejected', ...(snapshotId ? { snapshotId } : {}), error: errors.map((x) => x.text).join('; ') }).catch(() => undefined)
        }
      }
    } catch (e) {
      if (abort.signal.aborted) {
        update(id, (t) => ({ status: 'nothing', summary: tr('chat.cancelledSummary'), steps: t.steps.filter((s) => !s.transient) }))
        return
      }
      console.warn('[pleatkit] agent request failed', e)
      update(id, (t) => ({ status: 'failed', summary: tr('chat.failedSummary'), steps: t.steps.filter((s) => !s.transient) }))
    } finally {
      if (running.current === abort) running.current = null
      setBusy(false)
    }
  }

  /** The open clarifying question, if the last turn asked one and it is not answered yet. */
  const lastTurn = turns.at(-1)
  const openQuestion = lastTurn?.status === 'clarify' && lastTurn.clarify && !lastTurn.clarify.answered ? lastTurn : null

  const answer = (turn: Turn, reply: string) => {
    if (!turn.clarify || !turn.origin || !reply.trim()) return
    const { question } = turn.clarify
    update(turn.id, { clarify: { ...turn.clarify, answered: reply.trim() } })
    void run(turn.origin.request, false, turn.origin.attached, { question, answer: reply.trim() })
  }

  /** "undo" typed into the chat is the gesture, not a request for the model (brainstorm 14 §2). */
  const UNDO_WORDS = /^(undo|отмени(ть)?|верни( как было)?)\.?$/i

  const send = () => {
    const raw = text
    setText('')
    // text typed after a question is the answer to it
    if (openQuestion) {
      answer(openQuestion, raw)
      return
    }
    if (UNDO_WORDS.test(raw.trim())) {
      void undo()
      return
    }
    const attached = images
    setImages([])
    const t = target ? `[panel: ${target}] ${raw.replace(PANEL_TAG, '').trimStart()}` : raw
    setTarget(null)
    void run(t, false, attached)
  }

  const nav = async (op: () => Promise<Snapshot | null>, label: string, action?: Toast['action']) => {
    engine.draft.discard()
    const s = await op()
    if (s) toast(label, 'ok', action)
  }
  const redo = () => nav(() => engine.redo(), tr('toast.redone'), { label: tr('chat.undo'), run: () => void undo() })
  const undo = () => nav(() => engine.undo(), tr('toast.undone'), { label: tr('chat.redo'), run: () => void redo() })
  const reset = () => nav(() => engine.reset(), tr('toast.resetOriginal'), { label: tr('chat.redo'), run: () => void redo() })

  // Ctrl/Cmd+Z inside the drawer is undo, unless the user is editing text in the composer
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false)
      return
    }
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return
    const inText = e.target === input.current && text.length > 0
    if (inText || busy) return
    e.preventDefault()
    if (e.shiftKey) {
      if (state.canRedo) void redo()
    } else if (state.canUndo) void undo()
  }

  const head = state.head
  // F6 kill switch: no chat at all; everyone sees the original version
  if (state.disabled) return null
  const editsOff = !state.editsEnabled
  const changes = head?.parentId ? turnsApplied(history, head) : 0
  const canSend = !busy && !editsOff && text.trim().length > 0
  const restore = (engine as unknown as { checkout?: (id: string) => Promise<Snapshot | null> }).checkout
  return (
    <PleatkitUiRoot shadow={shadow}>
    <div className="mk-root" data-pleatkit-ui-layer="" lang={locale}>
      {state.stale && (
        <div className="mk-stale" role="status" data-testid="mk-stale">
          <span>{tr('chat.stale')}</span>
          <button type="button" className="mk-btn" data-testid="mk-stale-reset" disabled={busy} onClick={() => void nav(() => engine.reset(), tr('toast.resetNew'))}>
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
          ref={drawer}
          className={`mk-drawer ${dragging ? 'mk-dragging' : ''}`}
          aria-label={title ?? tr('chat.title')}
          data-testid="mk-chat"
          data-warm={warm}
          onKeyDown={onKey}
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
          <header className="mk-head">
            <div className="mk-title">{title ?? tr('chat.title')}</div>
            <div className="mk-ver">
              {head?.parentId || state.stale ? (
                <button type="button" data-testid="mk-chat-history" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}>
                  <span className="mk-n" data-testid="mk-chat-changes">{changes || '·'}</span>
                  <span>{tr('chat.version.changes', { n: changes })}</span>
                  <span className="mk-caret">▾</span>
                </button>
              ) : (
                <button type="button" data-testid="mk-chat-history" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}>
                  <span>{tr('chat.version.original')}</span>
                  <span className="mk-caret">▾</span>
                </button>
              )}
            </div>
            {state.canRedo && !busy && (
              <button type="button" className="mk-ico mk-redo" data-testid="mk-chat-redo" aria-label={tr('chat.redo')} data-tip={tr('chat.redo.tip')} onClick={() => void redo()}>
                {Icon.redo}
              </button>
            )}
            <button type="button" className="mk-ico mk-undo" data-testid="mk-chat-undo" aria-label={tr('chat.undoLast')} data-tip={tr('chat.undo.tip')} disabled={busy || !state.canUndo} onClick={() => void undo()}>
              {Icon.undo}
            </button>
            <button type="button" className="mk-ico mk-close" data-testid="mk-chat-close" aria-label={tr('chat.close')} data-tip={tr('chat.close.tip')} onClick={() => setOpen(false)}>
              {Icon.close}
            </button>
          </header>

          {showHistory && (
            <ol className="mk-history" data-testid="mk-history" aria-label={tr('chat.history')}>
              {timetable(history).map((s, i) => {
                const cur = s.id === head?.id
                return (
                  <li key={s.id} className={`${cur ? 'mk-cur' : ''} ${s.status === 'rejected' ? 'mk-rej' : ''}`} aria-current={cur ? 'true' : undefined}>
                    <span className="mk-v">v{i}</span>
                    <span title={s.id}>{s.author === 'base' ? tr('chat.history.original') : s.message}{s.author !== 'base' && <small className="mk-id" data-testid="mk-history-id">{s.id.slice(-8)}</small>}</span>
                    <span className="mk-t">{cur ? tr('chat.history.now') : new Date(s.createdAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</span>
                    {!cur && s.status !== 'rejected' && (s.author === 'base' ? (
                      <button type="button" className="mk-go" data-testid="mk-chat-reset" disabled={busy} onClick={() => void reset()}>{tr('chat.restore')}</button>
                    ) : restore ? (
                      <button type="button" className="mk-go" disabled={busy} onClick={() => void nav(() => restore.call(engine, s.id), tr('toast.restored'))}>{tr('chat.restore')}</button>
                    ) : <span />)}
                    {cur && <span />}
                  </li>
                )
              })}
            </ol>
          )}

          <div className="mk-body" ref={body} data-testid="mk-chat-body">
            {turns.length === 0 && (
              <div className="mk-empty">
                <p data-testid="mk-chat-disclaimer">{tr('chat.empty')}</p>
                {examples.length > 0 && (
                  <div className="mk-chips">
                    {examples.map((ex) => (
                      <button key={ex} type="button" className="mk-chip" onClick={() => { setText(ex); input.current?.focus() }}>
                        {ex}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {turns.map((t) => (
              <TurnView
                key={t.id}
                turn={t}
                tr={tr}
                tick={tick}
                undone={t.status === 'applied' && t.snapshotId !== undefined && t.snapshotId !== head?.id && !turns.some((o) => o.id > t.id && o.status === 'applied')}
                onAnswer={(reply) => answer(t, reply)}
                canAnswer={!busy && t === openQuestion}
                onRetry={() => void run(t.request, false, t.origin?.attached ?? [])}
                canRetry={!busy}
              />
            ))}
          </div>

          <div className="mk-foot">
            {editsOff ? (
              <div className="mk-paused" data-testid="mk-chat-paused">{tr('chat.editsOff')}</div>
            ) : (
              <>
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
                <div className="mk-box">
                  <textarea
                    ref={input}
                    className="mk-input"
                    rows={1}
                    title={tr('chat.attach.hint')}
                    onPaste={(e) => {
                      const files = imageFiles(e.clipboardData)
                      if (files.length === 0) return
                      // a screenshot, not text: keep it out of the text field
                      if (!e.clipboardData.getData('text/plain')) e.preventDefault()
                      void attach(files)
                    }}
                    data-testid="mk-chat-input"
                    placeholder={busy ? tr('chat.working') : openQuestion ? tr('chat.clarify.other') : tr('chat.placeholder')}
                    value={text}
                    disabled={busy}
                    onChange={(e) => {
                      // a `[panel: id]` tag typed or pasted into the text becomes the chip
                      const v = e.target.value
                      const m = PANEL_TAG.exec(v)
                      if (m && m[1]) {
                        setTarget(m[1])
                        setText(v.replace(PANEL_TAG, '').trimStart())
                      } else setText(v)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        if (canSend) send()
                      }
                    }}
                  />
                  <div className="mk-tools">
                    {target ? (
                      <button type="button" className="mk-tool mk-sel" data-testid="mk-chat-pick" aria-label={tr('chat.pick.clear', { panel: target })} disabled={busy} onClick={() => setTarget(null)}>
                        {Icon.pick}
                        <span>{target}</span>
                        <span aria-hidden="true">×</span>
                      </button>
                    ) : (
                      <button type="button" className={`mk-tool ${picking ? 'mk-sel' : ''}`} data-testid="mk-chat-pick" disabled={busy} onClick={() => setPicking(true)}>
                        {Icon.pick}
                        <span>{tr('chat.pick')}</span>
                      </button>
                    )}
                    <button type="button" className="mk-tool" data-testid="mk-chat-attach" aria-label={tr('chat.attach.hint')} disabled={busy} onClick={() => fileInput.current?.click()}>
                      {Icon.clip}
                    </button>
                    <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { void attach(Array.from(e.target.files ?? [])); e.target.value = '' }} />
                  </div>
                  <button
                    type="button"
                    className={`mk-send ${busy ? 'mk-stop' : canSend ? 'mk-active' : ''}`}
                    data-testid="mk-chat-send"
                    data-busy={busy || undefined}
                    aria-label={busy ? tr('chat.cancel') : tr('chat.send')}
                    title={busy ? tr('chat.cancel') : tr('chat.send.tip')}
                    disabled={busy ? !running.current : !canSend}
                    onClick={busy ? () => running.current?.abort() : send}
                  >
                    {busy ? Icon.stop : Icon.send}
                  </button>
                </div>
                <div className="mk-kbd" aria-hidden="true">
                  <span>{tr('chat.kbd.send')}</span>
                  <span>{tr('chat.kbd.undo')}</span>
                </div>
              </>
            )}
          </div>
        </aside>
      )}

      {picking && (
        <ElementPicker
          hint={tr('chat.pickHint')}
          onCancel={() => setPicking(false)}
          onPick={(id) => {
            setPicking(false)
            setTarget(id)
            input.current?.focus()
          }}
        />
      )}

      <div className="mk-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`mk-toast ${t.tone === 'bad' ? 'mk-t-bad' : t.tone === 'admin' ? 'mk-t-admin' : ''}`} data-testid="mk-toast">
            {t.text}
            {t.action && (
              <button type="button" onClick={() => { t.action?.run(); setToasts((all) => all.filter((x) => x.id !== t.id)) }}>
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
    </PleatkitUiRoot>
  )
}

/** Snapshots in timetable order: the original first, rejected ones kept (struck through), newest last. */
function timetable(history: Snapshot[]): Snapshot[] {
  return history.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** How many applied versions sit between the original and the head: the number on the "N changes" button. */
function turnsApplied(history: Snapshot[], head: Snapshot): number {
  if (history.length === 0) return 1
  const applied = history.filter((s) => s.author !== 'base' && s.status !== 'rejected')
  const beforeHead = applied.filter((s) => s.createdAt <= head.createdAt)
  return Math.max(1, beforeHead.length)
}

/** Model summaries are meant for the user; strip anything that still looks like code. */
function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .trim()
}

function TurnView({
  turn,
  tr,
  tick,
  undone,
  onAnswer,
  canAnswer,
  onRetry,
  canRetry,
}: {
  turn: Turn
  tr: Translate
  tick: number
  undone: boolean
  onAnswer: (reply: string) => void
  canAnswer: boolean
  onRetry: () => void
  canRetry: boolean
}) {
  const cost = turn.result?.usage.reduce((s, u) => s + (u.costUsd ?? 0), 0) ?? 0
  const live = turn.status === 'running' ? (turn.steps.at(-1)?.text ?? tr('chat.step.start')) : null
  const seconds = Math.max(0, Math.round((Date.now() - turn.startedAt) / 1000))
  void tick
  const mark =
    turn.status === 'applied' || turn.status === 'nothing' ? ['✓', ''] :
    turn.status === 'needs-backend' ? ['→', 'mk-info'] :
    turn.status === 'clarify' ? ['?', 'mk-info'] :
    turn.status === 'refused' ? ['·', 'mk-info'] : ['!', 'mk-warn']
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
      data-snapshot={turn.snapshotId}
    >
      <div className="mk-req">
        {turn.target && <span className="mk-pchip">{turn.target}</span>}
        {(turn.display ?? turn.request).replace(PANEL_TAG, '').trimStart()}
        {turn.images && (
          <span className="mk-req-thumbs" data-testid="mk-turn-images" aria-label={tr('chat.attach.count', { n: turn.images.length })}>
            {turn.images.map((src, i) => (
              <img key={i} src={src} alt="" />
            ))}
          </span>
        )}
      </div>

      {live !== null ? (
        <div className="mk-live" data-testid="mk-chat-live" aria-live="polite">
          <span className="mk-pulse" />
          <span className="mk-step" key={live}>{live}</span>
          <span className="mk-time">{seconds} s</span>
        </div>
      ) : (
        <div className="mk-res">
          <span className={`mk-mark ${mark[1]}`}>{mark[0]}</span>
          <div>
            {turn.status === 'needs-backend' && <p className="mk-summary" data-testid="mk-chat-summary">{turn.summary || tr('chat.adminSummary')}</p>}
            {turn.status !== 'needs-backend' && turn.status !== 'clarify' && (
              <p className={`mk-summary ${undone ? 'mk-undone' : ''}`} data-testid="mk-chat-summary">
                {turn.summary || (turn.status === 'applied' ? tr('chat.appliedSummary') : turn.status === 'nothing' ? tr('chat.nothingSummary') : tr('chat.failedSummary'))}
              </p>
            )}
            {turn.note && (
              <p className="mk-note" data-testid="mk-chat-note">
                <span>{tr('chat.partialNote')}</span> {turn.note}
              </p>
            )}
            {turn.status === 'clarify' && turn.clarify && (
              <div className="mk-clarify" data-testid="mk-clarify">
                <p className="mk-summary" data-testid="mk-chat-summary">{turn.clarify.question}</p>
                {turn.clarify.answered ? (
                  <div className="mk-meta">{turn.clarify.answered}</div>
                ) : (
                  <div className="mk-opts">
                    {turn.clarify.options.map((o) => (
                      <button key={o} type="button" data-testid="mk-clarify-option" disabled={!canAnswer} onClick={() => onAnswer(o)}>
                        {o}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {undone && <div className="mk-meta">{tr('chat.undoneNote')}</div>}
            {turn.review && (
              <div className="mk-meta" data-testid="mk-chat-review">
                {tr('chat.review')}
              </div>
            )}
            {(turn.status === 'failed' || turn.status === 'rejected') && (
              <button type="button" className="mk-retry" data-testid="mk-chat-retry" disabled={!canRetry} onClick={onRetry}>
                {tr('chat.retry')}
              </button>
            )}
            {turn.steps.length > 0 && (
              <details className="mk-steps">
                <summary data-testid="mk-chat-steps-toggle">{tr('chat.steps', { n: turn.steps.length })}</summary>
                <ul data-testid="mk-chat-steps">
                  {turn.steps.map((s, i) => (
                    <li key={i} className={s.tone === 'good' ? 'mk-good' : s.tone === 'bad' ? 'mk-bad' : undefined}>
                      {s.text}
                      {s.count && s.count > 1 ? <span className="mk-count">×{s.count}</span> : null}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
