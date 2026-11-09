import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { usePleatkitState } from '@pleatkit/runtime'

/**
 * First-visit onboarding of the public demo (docs/demo-hosting.md). On a wide monitor the CRM sits in the middle and
 * the drawer's launcher is a small pill in the far bottom-right corner, so the first visit dims the page around the
 * launcher and puts a card next to it. The launcher belongs to packages/ui (in the UI host's shadow root, unchanged):
 * the demo only measures it, draws around it, and clicks it the way a visitor would.
 */

const ONBOARDED = 'pk_demo_onboarded'
const APPLIED = 'pk_demo_applied'
const TOUR_EVENT = 'pk-demo-tour'
/** After the page is interactive and the launcher is on screen. */
const FIRST_DELAY_MS = 700
/** "Start the tour" from the strip: the visitor asked, so almost at once. */
const AGAIN_DELAY_MS = 120
const HINT_AFTER_MS = 4_000
/** Below this width the card sits above the launcher instead of to its left. */
const NARROW = 900
const GUTTER = 16
const HOLE_PAD = 8

const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value)
    } catch {
      /* private mode: the tour simply shows again next time */
    }
  },
}

/** Re-run the onboarding without a reload (the strip's "Start the tour"). */
export const startDemoTour = (): void => {
  window.dispatchEvent(new Event(TOUR_EVENT))
}

const uiRoot = (): ShadowRoot | null => document.querySelector('[data-pleatkit-ui-host]')?.shadowRoot ?? null
const launcherButton = (): HTMLElement | null => uiRoot()?.querySelector<HTMLElement>('[data-testid="mk-chat-open"]') ?? null

interface UiState {
  /** The launcher's rect while it is on screen (the drawer is closed). */
  launcher: DOMRect | null
  drawerOpen: boolean
  composerEmpty: boolean
  chipsShown: boolean
}

const EMPTY_UI: UiState = { launcher: null, drawerOpen: false, composerEmpty: true, chipsShown: false }

function readUi(): UiState {
  const root = uiRoot()
  if (!root) return EMPTY_UI
  const button = root.querySelector<HTMLElement>('[data-testid="mk-chat-open"]')
  const rect = button?.getBoundingClientRect()
  const composer = root.querySelector<HTMLTextAreaElement>('[data-testid="mk-chat-input"]')
  return {
    launcher: rect && rect.width > 0 ? rect : null,
    drawerOpen: Boolean(root.querySelector('[data-testid="mk-chat"]')),
    composerEmpty: !composer || composer.value.trim() === '',
    chipsShown: Boolean(root.querySelector('.mk-chip')),
  }
}

const sameRect = (a: DOMRect | null, b: DOMRect | null) =>
  a === b || (a !== null && b !== null && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height)

/** The drawer's launcher and composer, read from the UI host's shadow root (polled, and again on resize/scroll). */
function useUi(): UiState {
  const [ui, setUi] = useState<UiState>(EMPTY_UI)
  useEffect(() => {
    const update = () =>
      setUi((prev) => {
        const next = readUi()
        return sameRect(prev.launcher, next.launcher) && prev.drawerOpen === next.drawerOpen && prev.composerEmpty === next.composerEmpty && prev.chipsShown === next.chipsShown ? prev : next
      })
    update()
    const timer = setInterval(update, 200)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      clearInterval(timer)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [])
  return ui
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

function useViewport(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}

type Tour = { phase: 'idle' } | { phase: 'pending'; delay: number } | { phase: 'open' }

/**
 * Inside the PleatkitProvider, public demo only: the dim layer with a hole around the launcher, the card, the
 * launcher's pulse (until the visitor has applied one request), and the trigger from the strip.
 */
export function DemoOnboarding() {
  const ui = useUi()
  const viewport = useViewport()
  const { head } = usePleatkitState()
  const [tour, setTour] = useState<Tour>(() =>
    storage.get(ONBOARDED) === null || new URLSearchParams(location.search).get('tour') === '1' ? { phase: 'pending', delay: FIRST_DELAY_MS } : { phase: 'idle' },
  )
  const [applied, setApplied] = useState(() => storage.get(APPLIED) !== null)

  // one applied request (now, or already in this visitor's sandbox) and the launcher stops asking for attention
  useEffect(() => {
    if (applied || head?.author !== 'agent') return
    storage.set(APPLIED, '1')
    setApplied(true)
  }, [head, applied])

  // "Start the tour": close the drawer if it is open, then show the layer again
  useEffect(() => {
    const again = () => {
      if (readUi().drawerOpen) uiRoot()?.querySelector<HTMLElement>('[data-testid="mk-chat-close"]')?.click()
      setTour({ phase: 'pending', delay: AGAIN_DELAY_MS })
    }
    window.addEventListener(TOUR_EVENT, again)
    return () => window.removeEventListener(TOUR_EVENT, again)
  }, [])

  // pending -> open once the page is interactive and the launcher is measured
  const launcherReady = ui.launcher !== null && !ui.drawerOpen
  useEffect(() => {
    if (tour.phase !== 'pending' || !launcherReady) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      timer = setTimeout(() => setTour((t) => (t.phase === 'pending' && readUi().launcher && !readUi().drawerOpen ? { phase: 'open' } : t)), tour.delay)
    }
    if (document.readyState === 'complete') arm()
    else window.addEventListener('load', arm, { once: true })
    return () => {
      window.removeEventListener('load', arm)
      clearTimeout(timer)
    }
  }, [tour, launcherReady])

  const finish = useCallback(() => {
    storage.set(ONBOARDED, '1')
    setTour({ phase: 'idle' })
  }, [])

  // the visitor clicked the launcher itself through the hole: that is the tour done too
  useEffect(() => {
    if (tour.phase === 'open' && ui.drawerOpen) finish()
  }, [tour.phase, ui.drawerOpen, finish])

  const openDrawer = useCallback(() => {
    finish()
    launcherButton()?.click()
  }, [finish])

  const showing = tour.phase === 'open' && ui.launcher !== null && !ui.drawerOpen
  return (
    <>
      {ui.launcher && !ui.drawerOpen && (showing || !applied) && <LauncherPulse rect={ui.launcher} strong={showing} />}
      {showing && ui.launcher && <OnboardingLayer launcher={ui.launcher} viewport={viewport} onOpen={openDrawer} onSkip={finish} />}
    </>
  )
}

/** A soft ring that expands from the launcher's pill (behind it, so the launcher stays clickable). */
function LauncherPulse({ rect, strong }: { rect: DOMRect; strong: boolean }) {
  return (
    <div
      aria-hidden="true"
      data-testid="demo-launcher-pulse"
      className={`demo-launcher-pulse${strong ? ' demo-launcher-pulse--strong' : ''}`}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height, borderRadius: rect.height / 2 }}
    />
  )
}

function cardPosition(hole: { left: number; top: number; right: number; bottom: number }, viewport: { width: number; height: number }, card: { width: number; height: number }) {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
  if (viewport.width < NARROW) {
    // centred above the launcher, kept on screen
    const left = clamp((hole.left + hole.right) / 2 - card.width / 2, GUTTER, viewport.width - GUTTER - card.width)
    const top = clamp(hole.top - 14 - card.height, GUTTER, viewport.height - GUTTER - card.height)
    return { left, top, side: 'above' as const }
  }
  // to the left of the launcher, bottom edges aligned
  const left = clamp(hole.left - 20 - card.width, GUTTER, viewport.width - GUTTER - card.width)
  const top = clamp(hole.bottom - card.height, GUTTER, viewport.height - GUTTER - card.height)
  return { left, top, side: 'left' as const }
}

function OnboardingLayer({ launcher, viewport, onOpen, onSkip }: { launcher: DOMRect; viewport: { width: number; height: number }; onOpen: () => void; onSkip: () => void }) {
  const card = useRef<HTMLDivElement>(null)
  const [cardSize, setCardSize] = useState({ width: 380, height: 200 })
  const hole = { left: launcher.left - HOLE_PAD, top: launcher.top - HOLE_PAD, right: launcher.right + HOLE_PAD, bottom: launcher.bottom + HOLE_PAD }
  const width = Math.min(380, viewport.width - 2 * GUTTER)
  const pos = cardPosition(hole, viewport, { width, height: cardSize.height })

  useLayoutEffect(() => {
    const el = card.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setCardSize((s) => (s.width === r.width && s.height === r.height ? s : { width: r.width, height: r.height }))
    }
    measure()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [])

  // focus moves to the card (no ring on arrival; Tab reaches the buttons) and comes back where it was afterwards;
  // Escape skips; focus cannot leave the card by keyboard
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    card.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onSkip()
    }
    const onFocusIn = (e: FocusEvent) => {
      if (card.current && e.target instanceof Node && !card.current.contains(e.target) && e.target !== document.querySelector('[data-pleatkit-ui-host]')) card.current.focus({ preventScroll: true })
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusin', onFocusIn)
      if (before?.isConnected && before !== document.body) before.focus({ preventScroll: true })
    }
  }, [onSkip])

  const trap = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !card.current) return
    const items = [...card.current.querySelectorAll<HTMLElement>('button')]
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    if (document.activeElement === card.current) {
      e.preventDefault()
      ;(e.shiftKey ? last : first).focus()
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <>
      <div className="demo-onb-layer" data-testid="demo-onboarding" aria-hidden="true">
        <div
          className="demo-onb-hole"
          data-testid="demo-onboarding-hole"
          style={{ left: hole.left, top: hole.top, width: hole.right - hole.left, height: hole.bottom - hole.top, borderRadius: (hole.bottom - hole.top) / 2 }}
        />
      </div>
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="demo-onb-title"
        aria-describedby="demo-onb-text"
        tabIndex={-1}
        data-testid="demo-onboarding-card"
        data-side={pos.side}
        className={`demo-onb-card${reducedMotion() ? '' : ' demo-onb-card--in'}`}
        style={{ left: pos.left, top: pos.top, width, ['--demo-onb-arrow' as string]: `${Math.max(24, Math.min(width - 24, (hole.left + hole.right) / 2 - pos.left))}px` }}
        onKeyDown={trap}
      >
        <h2 id="demo-onb-title" className="demo-onb-title">
          Try it on this screen
        </h2>
        <p id="demo-onb-text" className="demo-onb-text">
          Open the drawer, pick one of six example requests, and watch the panel change. Undo is one click.
        </p>
        <div className="demo-onb-actions">
          <button type="button" data-testid="demo-onboarding-open" className="demo-onb-primary" onClick={onOpen}>
            Open the drawer
          </button>
          <button type="button" data-testid="demo-onboarding-skip" className="demo-onb-skip" aria-label="Skip the tour" onClick={onSkip}>
            Skip
          </button>
        </div>
      </div>
    </>
  )
}

/**
 * The one-line hint next to the drawer: after the drawer first opens, if the composer stays empty for 4 s while the
 * example requests are shown. Gone for good on the first chip click (or once the visitor types).
 */
export function useComposerHint(): string | null {
  const ui = useUi()
  const [dismissed, setDismissed] = useState(false)
  const [due, setDue] = useState(false)

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.composedPath().some((el) => el instanceof HTMLElement && el.classList.contains('mk-chip'))) setDismissed(true)
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])

  const idle = ui.drawerOpen && ui.composerEmpty && ui.chipsShown
  useEffect(() => {
    if (ui.drawerOpen && !ui.composerEmpty) setDismissed(true)
  }, [ui.drawerOpen, ui.composerEmpty])
  useEffect(() => {
    if (!idle || dismissed) {
      setDue(false)
      return
    }
    const t = setTimeout(() => setDue(true), HINT_AFTER_MS)
    return () => clearTimeout(t)
  }, [idle, dismissed])

  if (!due || dismissed || !idle) return null
  // on phones the drawer is a bottom sheet: the chips are below, not on the right
  const phone = typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches
  return `Pick a request ${phone ? 'below' : 'on the right'}, or type your own in live mode.`
}
