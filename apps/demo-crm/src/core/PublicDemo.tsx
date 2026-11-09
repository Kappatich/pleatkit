import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { usePleatkitState } from '@pleatkit/runtime'
import { startDemoTour, useComposerHint } from './DemoOnboarding'

/**
 * The public demo's page chrome (demo.pleatkit.com, docs/demo-hosting.md). Shown only when the page is served by the
 * demo server (`GET /demo/api/status` answers JSON); the normal demo, the e2e suite and `pnpm dev` never see it.
 * The drawer itself (packages/ui) is unchanged: the feedback strip and the privacy line dock to its left edge.
 */
export interface DemoStatus {
  mode: 'scripted' | 'live'
  liveLeft: number
  requests: { id: string; text: string }[]
  contactEmail: string
  siteUrl: string
  filmUrl: string
}

const listeners = new Set<() => void>()
/** Ask every mounted `useDemoStatus` to fetch the status again (after a run: the live counter changes). */
export const refreshDemoStatus = () => listeners.forEach((l) => l())

async function fetchStatus(): Promise<DemoStatus | null> {
  try {
    const res = await fetch('/demo/api/status', { headers: { accept: 'application/json' } })
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) return null
    return (await res.json()) as DemoStatus
  } catch {
    return null
  }
}

let fetchPatched = false
/** After each agent run (its stream fully read), the status is fetched again so "N live requests left" stays true. */
function watchRuns(): void {
  if (fetchPatched) return
  fetchPatched = true
  const original = window.fetch.bind(window)
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await original(...args)
    const target = args[0]
    const url = typeof target === 'string' ? target : target instanceof URL ? target.href : target.url
    if (/\/agent\/(v1\/)?run$/.test(new URL(url, location.href).pathname) && res.body) {
      void res
        .clone()
        .text()
        .catch(() => '')
        .finally(refreshDemoStatus)
    }
    return res
  }
}

export function useDemoStatus(): DemoStatus | null {
  const [status, setStatus] = useState<DemoStatus | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => void fetchStatus().then((s) => alive && setStatus(s))
    load()
    listeners.add(load)
    const timer = setInterval(load, 30_000)
    return () => {
      alive = false
      listeners.delete(load)
      clearInterval(timer)
    }
  }, [])
  useEffect(() => {
    if (status) watchRuns()
  }, [status])
  return status
}

export function sendDemoEvent(body: Record<string, unknown>): void {
  void fetch('/demo/api/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(() => undefined)
}

const linkClass = 'underline underline-offset-2 hover:text-foreground'

/** The strip at the top: what works here, the live counter, the way back. */
export function DemoStrip({ status, admin = false }: { status: DemoStatus; admin?: boolean }) {
  const live = status.mode === 'live'
  return (
    <div data-testid="demo-strip" className="border-b border-border bg-muted px-4 py-2 text-sm text-muted-foreground">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-medium text-foreground">
          <span className="font-semibold">Public demo.</span> Six example requests work; live requests:{' '}
          <span data-testid="demo-live-left">{live ? `${status.liveLeft} left today` : 'off in this demo'}</span>
        </span>
        <span className="flex flex-wrap gap-x-4">
          {admin ? (
            <a className={linkClass} href="/">
              Back to the CRM
            </a>
          ) : (
            <a className={linkClass} href="/admin" data-testid="demo-admin-link" onClick={() => sendDemoEvent({ type: 'admin_click' })}>
              Admin view
            </a>
          )}
          <a className={linkClass} href={status.filmUrl} target="_blank" rel="noopener" data-testid="demo-film-link" onClick={() => sendDemoEvent({ type: 'film_click' })}>
            Watch the film
          </a>
          {!admin && (
            <a className={linkClass} href="#pilot">
              Free pilot
            </a>
          )}
          <a className={linkClass} href={status.siteUrl} onClick={() => sendDemoEvent({ type: 'site_click' })}>
            pleatkit.com
          </a>
        </span>
        {admin ? (
          <a className={`${linkClass} ml-auto font-medium text-foreground`} href="/?tour=1" data-testid="demo-tour-link">
            Start the tour
          </a>
        ) : (
          <button type="button" className={`${linkClass} ml-auto cursor-pointer font-medium text-foreground`} data-testid="demo-tour-link" onClick={startDemoTour}>
            Start the tour
          </button>
        )}
      </div>
    </div>
  )
}

/** Page-level form: an e-mail for a pilot. Written to the demo server's leads.jsonl; nothing is sent anywhere. */
export function DemoLeadForm({ status }: { status: DemoStatus }) {
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setState('sending')
    const res = await fetch('/demo/api/lead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, note }) }).catch(() => null)
    if (res?.ok) setState('done')
    else {
      setError(((await res?.json().catch(() => null)) as { error?: string } | null)?.error ?? 'Could not save it, try again in a minute.')
      setState('error')
    }
  }
  return (
    <section id="pilot" data-testid="demo-lead" className="mx-auto mb-10 max-w-6xl px-6">
      <div className="rounded-lg border border-border bg-card p-5 shadow-soft">
        <h2 className="text-base font-semibold">Leave your email for a free pilot</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          pleatkit in your own app, with your customers, for a few weeks. We write back from {status.contactEmail}; the address is stored on this demo server only.
        </p>
        {state === 'done' ? (
          <p data-testid="demo-lead-done" className="mt-3 text-sm">
            Thank you. Alex will write to you.
          </p>
        ) : (
          <form className="mt-3 grid gap-2 md:grid-cols-[1fr_1.4fr_auto]" onSubmit={(e) => void submit(e)}>
            <input data-testid="demo-lead-email" type="email" required maxLength={254} placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-md border border-border bg-background px-3 py-2 text-sm" />
            <input data-testid="demo-lead-note" type="text" maxLength={1000} placeholder="Your product, optional" value={note} onChange={(e) => setNote(e.target.value)} className="rounded-md border border-border bg-background px-3 py-2 text-sm" />
            <button data-testid="demo-lead-send" type="submit" disabled={state === 'sending'} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
              Send
            </button>
          </form>
        )}
        {state === 'error' && <p className="mt-2 text-sm text-red-700">{error}</p>}
        <p className="mt-3 text-xs text-muted-foreground">Requests in this demo are recorded to improve pleatkit; don&apos;t paste private data.</p>
      </div>
    </section>
  )
}

const REASONS = [
  { id: 'wrong_panel', label: 'Wrong panel' },
  { id: 'looks_wrong', label: 'Looks wrong' },
  { id: 'not_what_i_meant', label: 'Did not do what I meant' },
] as const

/** True while the drawer is open (it lives in the pleatkit UI host's shadow root). */
function useDrawerOpen(): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const check = () => {
      const host = document.querySelector('[data-pleatkit-ui-host]')
      setOpen(Boolean(host?.shadowRoot?.querySelector('[data-testid="mk-chat"]')))
    }
    check()
    const timer = setInterval(check, 300)
    return () => clearInterval(timer)
  }, [])
  return open
}

/**
 * Inside the PleatkitProvider: watches the user's version. An agent edit that becomes the head shows the feedback
 * strip for its request; the head going back to the edit's parent is an undo (the undo button or Ctrl+Z just before)
 * or, without that, the runtime rolling back an edit that crashed. Both are reported with the time since applied.
 */
export function DemoTracker() {
  const { head, status } = usePleatkitState()
  const previous = useRef<typeof head>(null)
  const ready = useRef(false)
  const applied = useRef(new Map<string, { requestId: string; at: number }>())
  const undoIntent = useRef(0)
  const [feedback, setFeedback] = useState<{ requestId: string; step: 'ask' | 'reasons' | 'thanks' } | null>(null)
  const [reasons, setReasons] = useState<string[]>([])
  const [comment, setComment] = useState('')
  const drawerOpen = useDrawerOpen()
  const hint = useComposerHint()

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.composedPath().some((el) => el instanceof HTMLElement && el.dataset.testid === 'mk-chat-undo')) undoIntent.current = Date.now()
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') undoIntent.current = Date.now()
    }
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [])

  useEffect(() => {
    if (status !== 'ready') return
    const prev = previous.current
    previous.current = head
    // the version the page loaded with is not news
    if (!ready.current) {
      ready.current = true
      return
    }
    if ((prev?.id ?? null) === (head?.id ?? null)) return
    const now = Date.now()
    if (head && head.author === 'agent' && head.requestId && !applied.current.has(head.id)) {
      applied.current.set(head.id, { requestId: head.requestId, at: now })
      setFeedback({ requestId: head.requestId, step: 'ask' })
      setReasons([])
      setComment('')
      return
    }
    const undone = prev && prev.parentId === (head?.id ?? null) ? applied.current.get(prev.id) : undefined
    if (undone) sendDemoEvent({ type: now - undoIntent.current < 3_000 ? 'undo' : 'runtime_error', requestId: undone.requestId, ms: now - undone.at })
  }, [head, status])

  const send = useCallback(
    (answer: 'yes' | 'not_quite') => {
      if (!feedback) return
      void fetch('/demo/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: feedback.requestId, answer, reasons, comment }) }).catch(() => undefined)
      setFeedback({ ...feedback, step: 'thanks' })
    },
    [feedback, reasons, comment],
  )

  useEffect(() => {
    if (feedback?.step !== 'thanks') return
    const t = setTimeout(() => setFeedback(null), 4_000)
    return () => clearTimeout(t)
  }, [feedback])

  if (!drawerOpen) return null
  return (
    <div data-testid="demo-dock" className="demo-dock">
      {hint && (
        <p data-testid="demo-hint" role="status" className="demo-hint">
          {hint}
        </p>
      )}
      {feedback && (
        <div data-testid="demo-feedback" data-request-id={feedback.requestId} className="rounded-lg border border-border bg-card p-3 text-sm shadow-soft">
          {feedback.step === 'thanks' ? (
            <p data-testid="demo-feedback-thanks">Thanks, noted.</p>
          ) : (
            <>
              <p className="font-medium">Did it do what you asked?</p>
              <div className="mt-2 flex gap-2">
                <button type="button" data-testid="demo-feedback-yes" className="rounded-md border border-border px-3 py-1 hover:bg-muted" onClick={() => send('yes')}>
                  Yes
                </button>
                <button type="button" data-testid="demo-feedback-no" className="rounded-md border border-border px-3 py-1 hover:bg-muted" onClick={() => setFeedback({ ...feedback, step: 'reasons' })}>
                  Not quite
                </button>
              </div>
              {feedback.step === 'reasons' && (
                <div className="mt-3 grid gap-2">
                  <div className="flex flex-wrap gap-2">
                    {REASONS.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        data-testid={`demo-feedback-reason-${r.id}`}
                        aria-pressed={reasons.includes(r.id)}
                        className={`rounded-full border px-2.5 py-0.5 text-xs ${reasons.includes(r.id) ? 'border-foreground bg-foreground text-background' : 'border-border'}`}
                        onClick={() => setReasons((rs) => (rs.includes(r.id) ? rs.filter((x) => x !== r.id) : [...rs, r.id]))}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                  <textarea data-testid="demo-feedback-comment" rows={2} maxLength={1000} placeholder="What did you expect? (optional)" value={comment} onChange={(e) => setComment(e.target.value)} className="rounded-md border border-border bg-background px-2 py-1 text-sm" />
                  <button type="button" data-testid="demo-feedback-send" className="justify-self-start rounded-md bg-primary px-3 py-1 text-primary-foreground" onClick={() => send('not_quite')}>
                    Send
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
      <p data-testid="demo-privacy" className="rounded-md bg-card/90 px-2 py-1 text-xs text-muted-foreground shadow-soft">
        Requests in this demo are recorded to improve pleatkit; don&apos;t paste private data.
      </p>
    </div>
  )
}
