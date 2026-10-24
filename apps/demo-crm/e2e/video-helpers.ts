import fs from 'node:fs'
import type { BrowserContext, Locator, Page } from '@playwright/test'

// Helpers for demo-video.spec.ts (pnpm demo:video): the motion overlay drawn over the recorded pages (captions,
// a visible pointer with click ripples, motion labels that say whose screen this is, the pulse ring, the dim
// helper, the card flash and the full-frame title bands) and the event timeline that scripts/record-demo.mjs
// turns into the sound track. Nothing here runs in the normal e2e suite.

/** Sounds are placed from these events: one key tick per typed character, a click, the drawer swish, the
 * applied whoosh + chime, the band swell and the closing chime. */
export type SoundKind = 'key' | 'click' | 'drawer' | 'applied' | 'band' | 'close'

export interface Timeline {
  /** ms since the page (and so its video) was created */
  start: number
  end: number
  events: { t: number; kind: SoundKind }[]
}

/**
 * The page-side overlay, installed with context.addInitScript on every page. It exposes `window.__demo`.
 * Self-contained: Playwright serializes it into the page.
 */
export function overlay(): void {
  const PAPER = '#fbfaf7'
  const INK = '#1c1a17'
  const RED = '#e2361f'
  const SANS = '"Inter", "Helvetica Neue", Arial, sans-serif'
  const MONO = '"JetBrains Mono", ui-monospace, Consolas, monospace'
  const EASE = 'cubic-bezier(.2,.7,.2,1)'
  const get = (k: string): string | null => {
    try {
      return sessionStorage.getItem(k)
    } catch {
      return null
    }
  }
  const set = (k: string, v: string | null): void => {
    try {
      if (v === null) sessionStorage.removeItem(k)
      else sessionStorage.setItem(k, v)
    } catch {
      /* the overlay works without storage */
    }
  }
  // A band started on the previous page stays on screen through the navigation: the new page paints dark first,
  // then shows the same band until the spec wipes it out (no flash of white between the two pages).
  const carried = get('demo-band')
  if (carried && document.documentElement) document.documentElement.style.background = INK

  const CSS = `
    #demo-caption { position: fixed; left: 24px; bottom: 24px; z-index: 2147483600; max-width: 760px; padding: 12px 18px; pointer-events: none;
      border-radius: 8px; border-left: 4px solid ${RED}; background: ${INK}; color: ${PAPER}; font: 600 20px/1.35 ${SANS};
      box-shadow: 0 1px 2px rgba(28,26,23,.06), 0 10px 24px -18px rgba(28,26,23,.4); letter-spacing: -.01em; transition: opacity .25s; }
    #demo-caption small { display: block; font-weight: 400; font-size: 15px; color: #c7c0b5; margin-top: 2px; }
    #demo-caption:empty { opacity: 0; }
    #demo-caption.rise { animation: demo-rise .32s ${EASE}; }
    @keyframes demo-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    #demo-badge { position: fixed; left: 24px; bottom: 112px; z-index: 2147483600; padding: 3px 10px; pointer-events: none;
      border-radius: 999px; background: ${PAPER}; border: 1px solid #c3bdb2; color: #514c45; font: 500 11.5px/1.4 ${MONO}; letter-spacing: .04em; }
    #demo-pointer { position: fixed; z-index: 2147483640; width: 26px; height: 26px; margin: -13px 0 0 -13px; pointer-events: none;
      border-radius: 50%; background: rgba(226,54,31,.22); border: 2px solid ${RED}; box-sizing: border-box;
      box-shadow: 0 2px 8px rgba(28,26,23,.28), 0 0 0 1px rgba(251,250,247,.7); transition: transform .12s, background .12s; }
    #demo-pointer.down { transform: scale(.72); background: rgba(226,54,31,.6); }
    .demo-ripple { position: fixed; z-index: 2147483639; width: 26px; height: 26px; margin: -13px 0 0 -13px; pointer-events: none; box-sizing: border-box;
      border-radius: 50%; border: 2px solid ${RED}; animation: demo-ripple .6s cubic-bezier(0,0,.2,1) forwards; }
    @keyframes demo-ripple { from { transform: scale(.6); opacity: .95; } to { transform: scale(2.8); opacity: 0; } }
    .demo-pulse { position: fixed; z-index: 2147483620; pointer-events: none; box-sizing: border-box; border: 2px solid ${RED}; border-radius: 999px;
      animation: demo-pulse .6s ease-out 2 forwards; }
    @keyframes demo-pulse { from { box-shadow: 0 0 0 0 rgba(226,54,31,.5); opacity: 1; } to { box-shadow: 0 0 0 18px rgba(226,54,31,0); opacity: .15; } }
    .demo-label { position: fixed; z-index: 2147483610; pointer-events: none; display: inline-flex; align-items: center; gap: 8px; box-sizing: border-box;
      padding: 4px 11px 4px 9px; border-radius: 999px; font: 500 11px/1.2 ${MONO}; letter-spacing: .08em; white-space: nowrap;
      clip-path: inset(0 100% 0 0 round 999px); transition: clip-path .35s cubic-bezier(0,0,.2,1), opacity .6s; }
    .demo-label b { font-weight: 700; }
    .demo-label.on { clip-path: inset(0 0 0 0 round 999px); }
    .demo-label.dim { opacity: .6; }
    #demo-label-app { left: 16px; top: 55px; background: ${PAPER}; border: 1px solid #c3bdb2; color: ${INK}; box-shadow: 0 1px 2px rgba(28,26,23,.06), 0 6px 16px -10px rgba(28,26,23,.35); }
    #demo-label-app::before { content: ""; width: 8px; height: 8px; border-radius: 2px; background: ${RED}; }
    #demo-label-drawer { right: 92px; top: 55px; padding: 4px 11px 7px; border-radius: 4px; clip-path: inset(0 100% 0 0); background: ${INK}; color: ${PAPER}; }
    #demo-label-drawer.on { clip-path: inset(0 0 0 0); }
    #demo-label-drawer i { position: absolute; left: 11px; right: 11px; bottom: 4px; height: 1.5px; background: ${RED}; transform: scaleX(0); transform-origin: left; transition: transform .5s ${EASE} .3s; }
    #demo-label-drawer.on i { transform: scaleX(1); }
    #demo-label-admin { left: 12px; top: 98px; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 6px 10px;
      border-radius: 10px; clip-path: inset(0 100% 0 0 round 10px); letter-spacing: .04em; background: #fbe9e4; border: 1px solid ${RED}; color: #b7260f; }
    #demo-label-admin.on { clip-path: inset(0 0 0 0 round 10px); }
    .demo-dimmable { transition: filter .5s ease, opacity .5s ease; }
    .demo-dimmable.undim { transition: filter .6s ease, opacity .6s ease; }
    .demo-dim { filter: blur(2.5px); opacity: .45; }
    .demo-flash { animation: demo-flash .9s ease-out 1; }
    @keyframes demo-flash { 0% { box-shadow: 0 0 0 0 rgba(226,54,31,0); } 25% { box-shadow: 0 0 0 4px rgba(226,54,31,.6), 0 0 32px 6px rgba(226,54,31,.22); } 100% { box-shadow: 0 0 0 0 rgba(226,54,31,0); } }
    #demo-band { position: fixed; inset: 0; z-index: 2147483645; display: grid; place-items: center; background: ${INK}; pointer-events: none;
      clip-path: inset(0 100% 0 0); transition: clip-path .45s cubic-bezier(.65,0,.25,1); }
    #demo-band.on { clip-path: inset(0 0 0 0); }
    #demo-band.out { clip-path: inset(0 0 0 100%); }
    #demo-band .t { display: flex; flex-direction: column; align-items: center; gap: 12px; opacity: 0; transform: translateX(-16px);
      transition: opacity .35s ease .18s, transform .45s ${EASE} .18s; }
    #demo-band.on .t { opacity: 1; transform: none; }
    #demo-band b { display: inline-flex; align-items: center; gap: 14px; font: 700 36px/1.15 ${SANS}; color: ${PAPER}; letter-spacing: -.02em; }
    #demo-band b i { width: 14px; height: 14px; border-radius: 2px; background: ${RED}; }
    #demo-band span { font: 400 14px/1.4 ${MONO}; color: #c7c0b5; letter-spacing: .02em; }
    #demo-fade { position: fixed; inset: 0; z-index: 2147483646; background: ${PAPER}; opacity: 0; pointer-events: none; transition: opacity .9s ease; }
    #demo-fade.on { opacity: 1; }`

  const make = (tag: string, id: string, parent: HTMLElement = document.body): HTMLElement => {
    const e = document.createElement(tag)
    if (id) e.id = id
    parent.appendChild(e)
    return e
  }
  const nextFrame = (fn: () => void): void => void requestAnimationFrame(() => requestAnimationFrame(fn))

  const showBand = (b: { title: string; sub: string; mark?: boolean }, animate: boolean): void => {
    document.getElementById('demo-band')?.remove()
    const band = make('div', 'demo-band')
    const t = make('div', '', band)
    t.className = 't'
    const title = make('b', '', t)
    if (b.mark) make('i', '', title)
    title.append(b.title)
    make('span', '', t).textContent = b.sub
    if (animate) nextFrame(() => band.classList.add('on'))
    else {
      band.style.transition = 'none'
      t.style.transition = 'none'
      band.classList.add('on')
      nextFrame(() => {
        band.style.transition = ''
        t.style.transition = ''
      })
    }
  }

  const install = (): void => {
    if (document.getElementById('demo-style')) return
    const style = make('style', 'demo-style', document.head ?? document.documentElement)
    style.textContent = CSS
    make('div', 'demo-caption')
    // honest about what is replayed: the model's answers; everything after them runs for real
    make('div', 'demo-badge').textContent = 'Scripted agent: recorded model answers. Compile, commit, undo and storage are real.'
    const pointer = make('div', 'demo-pointer')
    const xy = (get('demo-xy') ?? '640,400').split(',').map(Number)
    pointer.style.left = `${xy[0]}px`
    pointer.style.top = `${xy[1]}px`
    addEventListener(
      'mousemove',
      (e) => {
        pointer.style.left = `${e.clientX}px`
        pointer.style.top = `${e.clientY}px`
        set('demo-xy', `${e.clientX},${e.clientY}`)
      },
      true,
    )
    addEventListener(
      'mousedown',
      (e) => {
        pointer.classList.add('down')
        const r = make('div', '')
        r.className = 'demo-ripple'
        r.style.left = `${e.clientX}px`
        r.style.top = `${e.clientY}px`
        setTimeout(() => r.remove(), 700)
      },
      true,
    )
    addEventListener('mouseup', () => pointer.classList.remove('down'), true)
    if (carried) showBand(JSON.parse(carried) as { title: string; sub: string; mark?: boolean }, false)
  }

  const DIM = ['header', '[data-testid="dashboard-panels"]', 'nav[aria-label="Customers"]', '[data-testid="deals-table"]']
  const api = {
    caption(title: string, sub: string): void {
      install()
      const el = document.getElementById('demo-caption')!
      el.innerHTML = ''
      el.classList.remove('rise')
      if (!title) return
      el.append(title)
      if (sub) make('small', '', el).textContent = sub
      void el.offsetWidth
      el.classList.add('rise')
    },
    /** A motion label: draws in from width 0 in 350 ms, dims to 60 % after 3 s. */
    label(kind: 'app' | 'drawer' | 'admin', strong: string, rest: string): void {
      install()
      document.getElementById(`demo-label-${kind}`)?.remove()
      const l = make('div', `demo-label-${kind}`)
      l.className = 'demo-label'
      make('b', '', l).textContent = strong
      if (rest) l.append(rest)
      if (kind === 'drawer') make('i', '', l)
      nextFrame(() => l.classList.add('on'))
      setTimeout(() => l.classList.add('dim'), 3000)
    },
    unlabel(kind: string): void {
      document.getElementById(`demo-label-${kind}`)?.remove()
    },
    /** Two red pulses around a box: what is about to be clicked. */
    pulse(x: number, y: number, w: number, h: number): void {
      const p = make('div', '')
      p.className = 'demo-pulse'
      Object.assign(p.style, { left: `${x - 4}px`, top: `${y - 4}px`, width: `${w + 8}px`, height: `${h + 8}px` })
      setTimeout(() => p.remove(), 1300)
    },
    /** Blur every app panel except the customer card, so the eye stays on the card. */
    dim(on: boolean): void {
      for (const sel of DIM)
        for (const e of document.querySelectorAll(sel)) {
          e.classList.add('demo-dimmable')
          e.classList.toggle('undim', !on)
          e.classList.toggle('demo-dim', on)
        }
    },
    flash(selector: string): void {
      const e = document.querySelector(selector)
      if (!e) return
      e.classList.remove('demo-flash')
      void (e as HTMLElement).offsetWidth
      e.classList.add('demo-flash')
      setTimeout(() => e.classList.remove('demo-flash'), 1000)
    },
    /** Full-frame title band, wiping in from the left; `carry` keeps it on screen through a navigation. */
    band(title: string, sub: string, mark: boolean, carry: boolean): void {
      install()
      if (carry) set('demo-band', JSON.stringify({ title, sub, mark }))
      showBand({ title, sub, mark }, true)
    },
    bandOut(): void {
      set('demo-band', null)
      const band = document.getElementById('demo-band')
      if (!band) return
      band.classList.add('out')
      setTimeout(() => {
        band.remove()
        document.documentElement.style.background = ''
      }, 520)
    },
    fade(): void {
      const f = make('div', 'demo-fade')
      nextFrame(() => f.classList.add('on'))
    },
  }
  ;(window as unknown as { __demo: typeof api }).__demo = api

  // install as soon as <body> exists, so a carried band is on the first frame of the new page
  if (document.body) install()
  else
    new MutationObserver((_, o) => {
      if (!document.body) return
      o.disconnect()
      install()
    }).observe(document, { childList: true, subtree: true })
}

type DemoApi = {
  caption(t: string, s: string): void
  label(k: string, a: string, b: string): void
  unlabel(k: string): void
  pulse(x: number, y: number, w: number, h: number): void
  dim(on: boolean): void
  flash(sel: string): void
  band(t: string, s: string, mark: boolean, carry: boolean): void
  bandOut(): void
  fade(): void
}

type DemoWindow = { __demo: DemoApi }

const easeInOut = (p: number): number => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)

/** Drives the recorded page like a person would, and keeps the timeline of everything that makes a sound. */
export class Film {
  private x = 640
  private y = 400
  readonly timeline: Timeline = { start: 0, end: 0, events: [] }

  private constructor(
    readonly page: Page,
    private readonly t0: number,
  ) {}

  /** Opens the recorded page. Its video starts when the page is created, so t0 is taken right before. */
  static async open(context: BrowserContext): Promise<Film> {
    const t0 = Date.now()
    return new Film(await context.newPage(), t0)
  }

  now(): number {
    return Date.now() - this.t0
  }

  sound(kind: SoundKind, at = this.now()): void {
    this.timeline.events.push({ t: at, kind })
  }

  mark(name: 'start' | 'end'): void {
    this.timeline[name] = this.now()
  }

  save(file: string): void {
    fs.writeFileSync(file, JSON.stringify(this.timeline, null, 1))
  }

  pause(ms: number): Promise<void> {
    return this.page.waitForTimeout(ms)
  }

  caption(title: string, sub = ''): Promise<void> {
    return this.page.evaluate(([t, s]) => (window as unknown as DemoWindow).__demo.caption(t, s), [title, sub] as const)
  }

  label(kind: 'app' | 'drawer' | 'admin', strong: string, rest = ''): Promise<void> {
    return this.page.evaluate(([k, a, b]) => (window as unknown as DemoWindow).__demo.label(k, a, b), [kind, strong, rest] as const)
  }

  dim(on: boolean): Promise<void> {
    return this.page.evaluate((o) => (window as unknown as DemoWindow).__demo.dim(o), on)
  }

  flash(selector: string): Promise<void> {
    return this.page.evaluate((s) => (window as unknown as DemoWindow).__demo.flash(s), selector)
  }

  async pulse(target: Locator): Promise<void> {
    const b = (await target.boundingBox())!
    await this.page.evaluate((r) => (window as unknown as DemoWindow).__demo.pulse(r.x, r.y, r.width, r.height), b)
  }

  /** The pointer moves the way a hand does: eased, wall-clock timed. */
  async glide(x: number, y: number, ms = 700): Promise<void> {
    const [x0, y0] = [this.x, this.y]
    const t = Date.now()
    for (;;) {
      const p = Math.min(1, (Date.now() - t) / ms)
      const e = easeInOut(p)
      await this.page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e)
      if (p >= 1) break
      await this.page.waitForTimeout(12)
    }
    this.x = x
    this.y = y
  }

  async glideTo(target: Locator, ms = 700, fx = 0.5, fy = 0.5): Promise<void> {
    await target.scrollIntoViewIfNeeded()
    const b = (await target.boundingBox())!
    await this.glide(Math.round(b.x + b.width * fx), Math.round(b.y + b.height * fy), ms)
  }

  /** Press and release where the pointer is: the overlay draws the ripple on mousedown. */
  async click(): Promise<void> {
    this.sound('click')
    await this.page.mouse.down()
    await this.page.waitForTimeout(70)
    await this.page.mouse.up()
  }

  async glideClick(target: Locator, ms = 700): Promise<void> {
    await this.glideTo(target, ms)
    await this.pause(180)
    await this.click()
  }

  /** 34 ms per character, 400 ms after a comma or a semicolon; one key tick per character. */
  async type(text: string): Promise<void> {
    for (const ch of text) {
      this.sound('key')
      await this.page.keyboard.type(ch)
      await this.page.waitForTimeout(ch === ',' || ch === ';' ? 434 : 34)
    }
  }

  /** Resolves on the animation frame the turn reaches `status` (the chat lives in a shadow root). */
  async waitStatus(index: number, status: string, timeout = 30_000): Promise<void> {
    await this.page.waitForFunction(
      ([i, s]) => {
        const roots: (Document | ShadowRoot)[] = [document]
        for (const e of document.querySelectorAll('*')) if (e.shadowRoot) roots.push(e.shadowRoot)
        for (const r of roots) {
          const turns = r.querySelectorAll('[data-testid="mk-chat-turn"]')
          if (turns.length > i) return turns[i]!.getAttribute('data-status') === s
        }
        return false
      },
      [index, status] as const,
      { polling: 'raf', timeout },
    )
  }

  /** Full-frame title band (1.6 s with bandOut); `carry` keeps it through the next navigation. */
  async band(title: string, sub: string, opts: { mark?: boolean; carry?: boolean } = {}): Promise<number> {
    this.sound('band')
    const at = Date.now()
    await this.page.evaluate(([t, s, m, c]) => (window as unknown as DemoWindow).__demo.band(t, s, m, c), [title, sub, !!opts.mark, !!opts.carry] as const)
    return at
  }

  /** Wipe the band out, no earlier than `minMs` after it started. */
  async bandOut(startedAt: number, minMs = 1150): Promise<void> {
    const wait = startedAt + minMs - Date.now()
    if (wait > 0) await this.pause(wait)
    await this.page.evaluate(() => (window as unknown as DemoWindow).__demo.bandOut())
  }

  fade(): Promise<void> {
    return this.page.evaluate(() => (window as unknown as DemoWindow).__demo.fade())
  }
}
