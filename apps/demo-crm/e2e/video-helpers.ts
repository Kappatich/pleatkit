import fs from 'node:fs'
import type { BrowserContext, Locator, Page } from '@playwright/test'

// Helpers for demo-video.spec.ts (pnpm demo:video). The film's visual language:
//  - a camera inside the page: the app (React root and the pleatkit drawer, which lives in a shadow root on <body>)
//    is wrapped in one element that is translated and scaled with a CSS transition, so the zoom is real pixels,
//    not a post-production crop;
//  - area plates: everything dimmed except one area, with a large title in the dark part; then a thin red frame
//    with one name tag stays on that area until the camera leaves it;
//  - the focus blur: four rects around the panel that changes, backdrop-blurred, so nothing else can be read;
//  - a few bottom captions, full-frame title bands, a visible pointer with click ripples.
// Every overlay element lives in a fixed container outside the camera, so it never zooms. The event timeline is
// what scripts/record-demo.mjs turns into the sound track. Nothing here runs in the normal e2e suite.

/** Sounds are placed from these events: one key tick per typed character, a click, the drawer swish, the applied
 * whoosh + chime, a soft whoosh per camera move, a low thud per plate, the band swell and the closing chime. */
export type SoundKind = 'key' | 'click' | 'drawer' | 'applied' | 'whoosh' | 'thud' | 'band' | 'close'

export interface Timeline {
  /** ms since the page (and so its video) was created */
  start: number
  end: number
  /** the poster frame (record-demo.mjs) */
  poster?: number
  /** named review moments: the frames to look at after a take */
  shots?: Record<string, number>
  events: { t: number; kind: SoundKind }[]
}

/** A rectangle in untransformed page coordinates (what the page looks like at zoom 1). */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** What a plate, frame or blur sits on: an element (CSS selector, also found inside the drawer's shadow root) or a
 * page rect; `pad` grows it in screen pixels (negative insets it). */
export interface Anchor {
  sel?: string
  rect?: Rect
  pad?: number
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
  type R = { x: number; y: number; width: number; height: number }
  type A = { sel?: string; rect?: R; pad?: number }
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
    html { overflow: hidden !important; padding-right: 0 !important; }
    #demo-cam { position: relative; box-sizing: border-box; width: 100vw; min-height: 100vh; transform-origin: 0 0; transform: translate(0px, 0px) scale(1); }
    #demo-ov { position: fixed; inset: 0; z-index: 2147483600; pointer-events: none; }
    #demo-ov div { pointer-events: none; box-sizing: border-box; }
    #demo-plate { position: fixed; inset: 0; opacity: 0; transition: opacity .3s ease; }
    #demo-plate.on { opacity: 1; }
    #demo-plate.out { opacity: 0; transition: opacity .35s ease; }
    #demo-plate .hole { position: fixed; border-radius: 8px; box-shadow: 0 0 0 9999px rgba(28,26,23,.62); }
    #demo-plate .txt { position: fixed; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
      text-align: center; color: #fff; text-shadow: 0 2px 22px rgba(28,26,23,.7); opacity: 0; transform: translateY(14px); transition: opacity .45s ease .12s, transform .6s ${EASE} .12s; }
    #demo-plate.on .txt { opacity: 1; transform: none; }
    #demo-plate .txt b { font: 600 44px/1.1 ${SANS}; letter-spacing: -.02em; }
    #demo-plate .txt i { display: block; width: 0; height: 3px; border-radius: 2px; background: ${RED}; transition: width .5s ${EASE} .35s; }
    #demo-plate.on .txt i { width: 56px; }
    #demo-plate .txt span { font: 400 20px/1.35 ${SANS}; color: rgba(255,255,255,.84); }
    #demo-frame { position: fixed; border: 2px solid ${RED}; border-radius: 8px; opacity: 0; transition: opacity .3s ease; }
    #demo-tag { position: fixed; padding: 5px 9px 4px; border-radius: 4px; background: ${RED}; color: #fff; white-space: nowrap;
      font: 600 13px/1 ${MONO}; letter-spacing: .1em; text-transform: uppercase; opacity: 0; transition: opacity .3s ease .12s; }
    #demo-frame.on, #demo-tag.on { opacity: 1; }
    #demo-frame.on.gone, #demo-tag.on.gone { opacity: 0; transition: opacity .2s ease; }
    .demo-blur { position: fixed; opacity: 0; transition: opacity .4s ease; background: rgba(251,250,247,.45);
      backdrop-filter: blur(var(--demo-blur, 5px)); -webkit-backdrop-filter: blur(var(--demo-blur, 5px)); }
    .demo-blur.on { opacity: 1; }
    #demo-caption { position: fixed; z-index: 3; left: 50%; bottom: 34px; max-width: 1100px; padding: 14px 28px 15px; border-radius: 999px; white-space: nowrap;
      background: rgba(28,26,23,.94); color: ${PAPER}; font: 600 30px/1.2 ${SANS}; letter-spacing: -.015em; transform: translateX(-50%);
      box-shadow: 0 2px 6px rgba(28,26,23,.18), 0 18px 40px -18px rgba(28,26,23,.55); transition: opacity .3s ease; }
    #demo-caption:empty { opacity: 0; }
    #demo-caption.rise { animation: demo-rise .4s ${EASE}; }
    @keyframes demo-rise { from { opacity: 0; transform: translate(-50%, 12px); } to { opacity: 1; transform: translate(-50%, 0); } }
    #demo-pointer { position: fixed; z-index: 4; width: 26px; height: 26px; margin: -13px 0 0 -13px; border-radius: 50%;
      background: rgba(226,54,31,.22); border: 2px solid ${RED}; box-shadow: 0 2px 8px rgba(28,26,23,.28), 0 0 0 1px rgba(251,250,247,.7);
      transition: transform .12s, background .12s; }
    #demo-pointer.down { transform: scale(.72); background: rgba(226,54,31,.6); }
    .demo-ripple { position: fixed; z-index: 4; width: 26px; height: 26px; margin: -13px 0 0 -13px; border-radius: 50%; border: 2px solid ${RED};
      animation: demo-ripple .6s cubic-bezier(0,0,.2,1) forwards; }
    @keyframes demo-ripple { from { transform: scale(.6); opacity: .95; } to { transform: scale(2.8); opacity: 0; } }
    .demo-pulse { position: fixed; border: 2px solid ${RED}; border-radius: 999px; animation: demo-pulse .6s ease-out 2 forwards; }
    @keyframes demo-pulse { from { box-shadow: 0 0 0 0 rgba(226,54,31,.5); opacity: 1; } to { box-shadow: 0 0 0 26px rgba(226,54,31,0); opacity: .15; } }
    #demo-band { position: fixed; inset: 0; z-index: 5; display: grid; place-items: center; background: ${INK};
      clip-path: inset(0 100% 0 0); transition: clip-path .45s cubic-bezier(.65,0,.25,1); }
    #demo-band.on { clip-path: inset(0 0 0 0); }
    #demo-band.out { clip-path: inset(0 0 0 100%); }
    #demo-band .t { display: flex; flex-direction: column; align-items: center; gap: 16px; opacity: 0; transform: translateX(-16px);
      transition: opacity .35s ease .18s, transform .45s ${EASE} .18s; }
    #demo-band.on .t { opacity: 1; transform: none; }
    #demo-band b { display: inline-flex; align-items: center; gap: 18px; font: 700 56px/1.1 ${SANS}; color: ${PAPER}; letter-spacing: -.025em; }
    #demo-band b i { width: 18px; height: 18px; border-radius: 3px; background: ${RED}; }
    #demo-band span { font: 400 22px/1.4 ${SANS}; color: #c7c0b5; }
    #demo-band small { margin-top: 26px; font: 400 14px/1.4 ${MONO}; color: #8f877b; letter-spacing: .02em; }
    #demo-fade { position: fixed; inset: 0; z-index: 6; background: ${PAPER}; opacity: 0; transition: opacity .9s ease; }
    #demo-fade.on { opacity: 1; }`

  const make = (tag: string, id: string, parent: Element): HTMLElement => {
    const e = document.createElement(tag)
    if (id) e.id = id
    parent.appendChild(e)
    return e
  }
  const nextFrame = (fn: () => void): void => void requestAnimationFrame(() => requestAnimationFrame(fn))
  const ov = (): HTMLElement => document.getElementById('demo-ov') ?? make('div', 'demo-ov', document.body)
  const cam = (): HTMLElement | null => document.getElementById('demo-cam')

  // ---- camera: the app's mount and the drawer's shadow host, wrapped in one transformed element ----------------
  const OWN = new Set(['demo-cam', 'demo-ov'])
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'TEMPLATE', 'NOSCRIPT'])
  const adopt = (n: Node): void => {
    const c = cam()
    if (!c || !(n instanceof HTMLElement) || OWN.has(n.id) || SKIP.has(n.tagName) || n.parentNode !== document.body) return
    c.appendChild(n)
  }
  const matrix = (): DOMMatrix => {
    const c = cam()
    const t = c ? getComputedStyle(c).transform : 'none'
    return !t || t === 'none' ? new DOMMatrix() : new DOMMatrix(t)
  }
  let camKey = ''
  let settle = 0

  const find = (sel: string): Element | null => {
    const e = document.querySelector(sel)
    if (e) return e
    for (const h of document.querySelectorAll('[data-pleatkit-ui-host]')) {
      const f = h.shadowRoot?.querySelector(sel)
      if (f) return f
    }
    return null
  }
  /** An anchor's rect on screen right now (mid-transition included). */
  const screenRect = (a: A): R | null => {
    let r: R
    if (a.sel) {
      const e = find(a.sel)
      if (!e) return null
      const b = e.getBoundingClientRect()
      r = { x: b.x, y: b.y, width: b.width, height: b.height }
    } else if (a.rect) {
      const m = matrix()
      r = { x: m.e + m.a * a.rect.x, y: m.f + m.d * a.rect.y, width: m.a * a.rect.width, height: m.d * a.rect.height }
    } else return null
    const p = a.pad ?? 0
    return { x: r.x - p, y: r.y - p, width: r.width + 2 * p, height: r.height + 2 * p }
  }
  const place = (e: HTMLElement, r: R): void => {
    e.style.left = `${r.x}px`
    e.style.top = `${r.y}px`
    e.style.width = `${r.width}px`
    e.style.height = `${r.height}px`
  }

  // tracked overlays, repositioned every frame so they follow the camera and the panels' own layout changes
  let plateAnchor: A | null = null
  let frameAnchor: A | null = null
  let frameAlign = 0
  let blurAnchor: A | null = null
  const tick = (): void => {
    if (scrollX || scrollY) scrollTo(0, 0) // the camera pans; the window never scrolls
    if (plateAnchor) {
      const r = screenRect(plateAnchor)
      const hole = document.querySelector<HTMLElement>('#demo-plate .hole')
      if (r && hole) place(hole, r)
    }
    const frame = document.getElementById('demo-frame')
    const tag = document.getElementById('demo-tag')
    if (frameAnchor && frame && tag) {
      const r = screenRect(frameAnchor)
      if (r) {
        place(frame, r)
        // the frame and its tag show only while the whole area is on screen: zoomed into a part of it, they go
        const out = r.x < -2 || r.y < -2 || r.x + r.width > innerWidth + 2 || r.y + r.height > innerHeight + 2
        frame.classList.toggle('gone', out)
        tag.classList.toggle('gone', out)
        // the tag sits on the frame's top edge; pushed inside when the edge is at the top of the screen
        const w = tag.offsetWidth
        const h = tag.offsetHeight
        const x = Math.min(r.x + r.width - w - 14, Math.max(r.x + 14, r.x + (r.width - w) * frameAlign))
        tag.style.left = `${Math.round(x)}px`
        tag.style.top = `${Math.round(Math.max(6, r.y - h / 2))}px`
      }
    }
    if (blurAnchor) {
      const r = screenRect(blurAnchor)
      const parts = document.querySelectorAll<HTMLElement>('.demo-blur')
      if (r && parts.length === 4) {
        const [vw, vh] = [innerWidth, innerHeight]
        const x0 = Math.max(0, r.x)
        const y0 = Math.max(0, r.y)
        const x1 = Math.min(vw, r.x + r.width)
        const y1 = Math.min(vh, r.y + r.height)
        place(parts[0]!, { x: 0, y: 0, width: vw, height: y0 })
        place(parts[1]!, { x: 0, y: y1, width: vw, height: vh - y1 })
        place(parts[2]!, { x: 0, y: y0, width: x0, height: y1 - y0 })
        place(parts[3]!, { x: x1, y: y0, width: vw - x1, height: y1 - y0 })
      }
    }
    requestAnimationFrame(tick)
  }

  const showBand = (b: { title: string; sub: string; mark?: boolean; note?: string }, animate: boolean): void => {
    document.getElementById('demo-band')?.remove()
    const band = make('div', 'demo-band', ov())
    const t = make('div', '', band)
    t.className = 't'
    const title = make('b', '', t)
    if (b.mark) make('i', '', title)
    title.append(b.title)
    make('span', '', t).textContent = b.sub
    if (b.note) make('small', '', t).textContent = b.note
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
    const c = document.createElement('div')
    c.id = 'demo-cam'
    document.body.prepend(c)
    for (const n of Array.from(document.body.childNodes)) adopt(n)
    // the open drawer pushes the page with padding on <html>; inside the camera that padding goes on the camera
    // element instead, so the app still makes room while the fixed drawer keeps the full width as its frame
    const push = (): void => void (c.style.paddingRight = document.documentElement.style.paddingRight)
    new MutationObserver(push).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    push()
    new MutationObserver((records) => {
      for (const rec of records) for (const n of rec.addedNodes) adopt(n)
    }).observe(document.body, { childList: true })
    const o = ov()
    make('div', 'demo-caption', o)
    const pointer = make('div', 'demo-pointer', o)
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
        const r = make('div', '', o)
        r.className = 'demo-ripple'
        r.style.left = `${e.clientX}px`
        r.style.top = `${e.clientY}px`
        setTimeout(() => r.remove(), 700)
      },
      true,
    )
    addEventListener('mouseup', () => pointer.classList.remove('down'), true)
    if (carried) showBand(JSON.parse(carried) as { title: string; sub: string; mark?: boolean }, false)
    requestAnimationFrame(tick)
  }

  const api = {
    /**
     * Point the camera at a page rect: scale `zoom`, translated so the rect is centred, clamped so no edge of the
     * page ever leaves the screen. `null` is the full view. Returns false when the camera is already there.
     */
    camera(target: R | null, zoom: number, ms: number): boolean {
      const c = cam()
      if (!c) return false
      const [vw, vh] = [innerWidth, innerHeight]
      let [tx, ty, z] = [0, 0, 1]
      if (target) {
        z = Math.max(1, zoom)
        const docW = Math.max(vw, c.scrollWidth)
        const docH = Math.max(vh, c.scrollHeight)
        const [viewW, viewH] = [vw / z, vh / z]
        const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi))
        const vx = clamp(target.x + target.width / 2 - viewW / 2, 0, docW - viewW)
        const vy = clamp(target.y + target.height / 2 - viewH / 2, 0, docH - viewH)
        tx = Math.round(-vx * z)
        ty = Math.round(-vy * z)
      }
      const key = `translate(${tx}px, ${ty}px) scale(${z})`
      if (key === camKey) return false
      camKey = key
      // composited while it moves (one raster, scaled), re-rastered sharp once it settles
      c.style.willChange = 'transform'
      c.style.transition = ms ? `transform ${ms}ms ${EASE}` : 'none'
      c.style.transform = key
      window.clearTimeout(settle)
      settle = window.setTimeout(() => (c.style.willChange = ''), ms + 40)
      return true
    },
    /** An element's rect in page coordinates (the camera's current transform taken out). */
    pageRect(sel: string): R | null {
      const e = find(sel)
      return e ? api.toPage(e.getBoundingClientRect()) : null
    },
    /** A screen rect (e.g. Playwright's boundingBox) in page coordinates. */
    toPage(b: R): R {
      const m = matrix()
      return { x: (b.x - m.e) / m.a, y: (b.y - m.f) / m.d, width: b.width / m.a, height: b.height / m.d }
    },
    /** Dim everything but the area; a large title in the biggest dark part of the screen, never over the area. */
    plate(anchor: A, title: string, sub: string, side: string): void {
      install()
      document.getElementById('demo-plate')?.remove()
      const r = screenRect(anchor)
      if (!r) return
      plateAnchor = anchor
      const plate = make('div', 'demo-plate', ov())
      place(make('div', '', plate), r)
      plate.firstElementChild!.className = 'hole'
      const [vw, vh] = [innerWidth, innerHeight]
      const sides: Record<string, R> = {
        left: { x: 0, y: 0, width: r.x, height: vh },
        right: { x: r.x + r.width, y: 0, width: vw - r.x - r.width, height: vh },
        above: { x: 0, y: 0, width: vw, height: r.y },
        below: { x: 0, y: r.y + r.height, width: vw, height: vh - r.y - r.height },
      }
      const regions = Object.values(sides).filter((g) => g.width >= 360 && g.height >= 150)
      regions.sort((a, b) => b.width * b.height - a.width * a.height)
      const g = sides[side] ?? regions[0] ?? { x: 0, y: 0, width: vw, height: vh }
      const txt = make('div', '', plate)
      txt.className = 'txt'
      place(txt, { x: g.x + 24, y: g.y + 16, width: g.width - 48, height: g.height - 32 })
      make('b', '', txt).textContent = title
      make('i', '', txt)
      if (sub) make('span', '', txt).textContent = sub
      nextFrame(() => plate.classList.add('on'))
    },
    plateOut(): void {
      const plate = document.getElementById('demo-plate')
      if (!plate) return
      plate.classList.add('out')
      setTimeout(() => {
        plate.remove()
        plateAnchor = null
      }, 400)
    },
    /** A thin red frame on the area with one name tag on its top edge (`align` 0..1 along the edge). */
    frame(anchor: A, name: string, align: number): void {
      install()
      api.unframe()
      frameAnchor = anchor
      frameAlign = align
      const f = make('div', 'demo-frame', ov())
      const t = make('div', 'demo-tag', ov())
      t.textContent = name
      nextFrame(() => {
        f.classList.add('on')
        t.classList.add('on')
      })
    },
    unframe(): void {
      for (const id of ['demo-frame', 'demo-tag']) {
        const e = document.getElementById(id)
        if (!e) continue
        e.id = ''
        e.style.transition = 'opacity .25s ease'
        e.classList.remove('on')
        setTimeout(() => e.remove(), 300)
      }
      frameAnchor = null
    },
    /** Blur and fade everything but the anchor (four backdrop-blurred rects around it). */
    blur(anchor: A | null, px: number): void {
      install()
      if (anchor) {
        blurAnchor = anchor
        if (!document.querySelector('.demo-blur'))
          for (let i = 0; i < 4; i++) {
            const b = make('div', '', ov())
            b.className = 'demo-blur'
            b.style.setProperty('--demo-blur', `${px}px`)
          }
        tick()
        nextFrame(() => document.querySelectorAll('.demo-blur').forEach((b) => b.classList.add('on')))
      } else {
        document.querySelectorAll('.demo-blur').forEach((b) => b.classList.remove('on'))
        setTimeout(() => {
          if (document.querySelector('.demo-blur.on')) return
          document.querySelectorAll('.demo-blur').forEach((b) => b.remove())
          blurAnchor = null
        }, 450)
      }
    },
    caption(text: string): void {
      install()
      const el = document.getElementById('demo-caption')!
      el.textContent = ''
      el.classList.remove('rise')
      if (!text) return
      el.textContent = text
      void el.offsetWidth
      el.classList.add('rise')
    },
    /** Two red pulses around a box (screen coordinates): what is about to be clicked. */
    pulse(x: number, y: number, w: number, h: number): void {
      const p = make('div', '', ov())
      p.className = 'demo-pulse'
      Object.assign(p.style, { left: `${x - 5}px`, top: `${y - 5}px`, width: `${w + 10}px`, height: `${h + 10}px` })
      setTimeout(() => p.remove(), 1300)
    },
    /** Full-frame title band, wiping in from the left; `carry` keeps it on screen through a navigation. */
    band(title: string, sub: string, mark: boolean, carry: boolean, note: string): void {
      install()
      if (carry) set('demo-band', JSON.stringify({ title, sub, mark }))
      showBand({ title, sub, mark, note }, true)
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
      const f = make('div', 'demo-fade', ov())
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
  camera(r: Rect | null, zoom: number, ms: number): boolean
  pageRect(sel: string): Rect | null
  toPage(r: Rect): Rect
  plate(a: Anchor, title: string, sub: string, side: string): void
  plateOut(): void
  frame(a: Anchor, name: string, align: number): void
  unframe(): void
  blur(a: Anchor | null, px: number): void
  caption(t: string): void
  pulse(x: number, y: number, w: number, h: number): void
  band(t: string, s: string, mark: boolean, carry: boolean, note: string): void
  bandOut(): void
  fade(): void
}

type DemoWindow = { __demo: DemoApi }

const easeInOut = (p: number): number => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)

/** A camera target: an element (CSS selector, shadow root included), a page rect, or null for the full view. */
export type Target = string | Rect | null

const anchor = (t: string | Rect, pad = 0): Anchor => (typeof t === 'string' ? { sel: t, pad } : { rect: t, pad })

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

  mark(name: 'start' | 'end' | 'poster'): void {
    this.timeline[name] = this.now()
  }

  /** Remember a moment to review after the take (`ahead` ms from now). */
  shot(name: string, ahead = 0): void {
    ;(this.timeline.shots ??= {})[name] = this.now() + ahead
  }

  save(file: string): void {
    fs.writeFileSync(file, JSON.stringify(this.timeline, null, 1))
  }

  pause(ms: number): Promise<void> {
    return this.page.waitForTimeout(ms)
  }

  /** A target's rect in page coordinates (untransformed), e.g. to aim the camera a little off an element. */
  async rect(target: string | Locator): Promise<Rect> {
    const r =
      typeof target === 'string'
        ? await this.page.evaluate((s) => (window as unknown as DemoWindow).__demo.pageRect(s), target)
        : await this.page.evaluate((b) => (b ? (window as unknown as DemoWindow).__demo.toPage(b) : null), await target.boundingBox())
    if (!r) throw new Error(`nothing on the page for ${String(target)}`)
    return r
  }

  /** Move the camera and wait until it settles; a soft whoosh when it actually moves. */
  async camera(target: Target | Locator, zoom = 1, ms = 900): Promise<void> {
    const rect = target === null ? null : typeof target === 'string' || 'boundingBox' in target ? await this.rect(target) : target
    const moved = await this.page.evaluate(([r, z, d]) => (window as unknown as DemoWindow).__demo.camera(r, z, d), [rect, zoom, ms] as const)
    if (moved) this.sound('whoosh')
    await this.pause(moved ? ms + 80 : 0)
  }

  /** Plate on an area: dim in 300 ms, hold, fade out in 350 ms. The title goes in the biggest dark part of the
   * screen, or on the given `side` of the area. */
  async plate(target: string | Rect, title: string, sub = '', opts: { hold?: number; pad?: number; side?: 'left' | 'right' | 'above' | 'below' } = {}): Promise<void> {
    const hold = opts.hold ?? 1800
    this.sound('thud')
    this.shot(`plate ${title}`, 1100)
    await this.page.evaluate(([a, t, s, d]) => (window as unknown as DemoWindow).__demo.plate(a, t, s, d), [anchor(target, opts.pad), title, sub, opts.side ?? ''] as const)
    await this.pause(300 + hold)
    await this.page.evaluate(() => (window as unknown as DemoWindow).__demo.plateOut())
    await this.pause(400)
  }

  frame(target: string | Rect, name: string, align = 0, pad = 0): Promise<void> {
    return this.page.evaluate(([a, n, al]) => (window as unknown as DemoWindow).__demo.frame(a, n, al), [anchor(target, pad), name, align] as const)
  }

  unframe(): Promise<void> {
    return this.page.evaluate(() => (window as unknown as DemoWindow).__demo.unframe())
  }

  /** Blur everything but the target (null: blur off); 400 ms fade. */
  async blur(target: string | Rect | null, pad = 10, px = 5): Promise<void> {
    await this.page.evaluate(([a, p]) => (window as unknown as DemoWindow).__demo.blur(a, p), [target === null ? null : anchor(target, pad), px] as const)
  }

  caption(text: string): Promise<void> {
    return this.page.evaluate((t) => (window as unknown as DemoWindow).__demo.caption(t), text)
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

  /** Glide to a point of the target's on-screen box (Playwright's box already includes the camera transform). */
  async glideTo(target: Locator, ms = 700, fx = 0.5, fy = 0.5): Promise<void> {
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

  async glideClick(target: Locator, ms = 700, fx = 0.5, fy = 0.5): Promise<void> {
    await this.glideTo(target, ms, fx, fy)
    await this.pause(180)
    await this.click()
  }

  /**
   * 34 ms per character, 400 ms after a comma or a semicolon; one key tick per character. Paced by the wall clock:
   * when a keystroke takes longer than its slot (the page re-renders the zoomed drawer on every key), the
   * characters that are due go in together, so the typing keeps its length whatever the machine's load.
   */
  async type(text: string): Promise<void> {
    const chars = [...text]
    const due: number[] = []
    let at = 0
    for (const ch of chars) {
      due.push(at)
      at += ch === ',' || ch === ';' ? 434 : 34
    }
    const t0 = Date.now()
    let i = 0
    while (i < chars.length) {
      const now = Date.now() - t0
      let j = i
      while (j < chars.length && due[j]! <= now) j++
      if (j === i) {
        await this.page.waitForTimeout(due[i]! - now)
        continue
      }
      for (let k = i; k < j; k++) this.sound('key', this.now() - (now - due[k]!))
      await this.page.keyboard.type(chars.slice(i, j).join(''))
      i = j
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
  async band(title: string, sub: string, opts: { mark?: boolean; carry?: boolean; note?: string } = {}): Promise<number> {
    this.sound('band')
    const at = Date.now()
    await this.page.evaluate(([t, s, m, c, n]) => (window as unknown as DemoWindow).__demo.band(t, s, m, c, n), [title, sub, !!opts.mark, !!opts.carry, opts.note ?? ''] as const)
    return at
  }

  /** Wipe the band out, no earlier than `minMs` after it started. */
  async bandOut(startedAt: number, minMs = 1300): Promise<void> {
    const wait = startedAt + minMs - Date.now()
    if (wait > 0) await this.pause(wait)
    await this.page.evaluate(() => (window as unknown as DemoWindow).__demo.bandOut())
  }

  fade(): Promise<void> {
    return this.page.evaluate(() => (window as unknown as DemoWindow).__demo.fade())
  }
}
