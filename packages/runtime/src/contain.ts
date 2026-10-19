import { capZIndex, watchPanel } from './z-cap.js'

/**
 * DECISIONS 84.4: what an edit renders cannot paint outside the box of its panel. The z-index cap (82.4) keeps an
 * edit under the launcher, but a `position: fixed; inset: 0` element below 999 still covered the host's header. The
 * panel's wrapper stays `display: contents` (its children remain the host's grid and flex items, so the host layout
 * is unchanged); while the panel runs an edit:
 *
 * 1. its own root elements (the wrapper's element children, through nested `display: contents`) get
 *    `contain: paint`: each becomes the containing block of its fixed and absolute descendants and clips everything
 *    inside it to its own box. Placement in the host layout does not change (no new box, same grid/flex item);
 * 2. a root that is itself fixed (anchored to the viewport, so no panel box can hold it across scrolling), or absolute
 *    and reaching outside the host element that holds the panel, is made `position: static`;
 * 3. a fixed or absolute element not inside any paint containment of the panel (its root cannot take one: an inline
 *    `<span>`, a table row) gets `contain: paint` on its nearest ancestor in the panel that can take it, else it is
 *    made `position: static`.
 *
 * Positioned elements whose box reaches outside the panel's box are marked `data-pleatkit-contained` (`clip`: painted
 * only inside a contained ancestor; `static`: taken out of positioning); elements given `contain: paint` are marked
 * `data-pleatkit-clip`. Applied only while the panel runs an edit; the release's own code is the developer's.
 */

/** A box in viewport coordinates (a DOMRect has these). */
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** Sub-pixel rounding of the layout: a box this close to the panel's edge is inside. */
export const CONTAIN_SLACK_PX = 1

/** Elements examined per pass at most (as the z-index cap). */
const MAX_ELEMENTS = 5000

const empty = (b: Box) => b.right - b.left <= 0 || b.bottom - b.top <= 0

/** Does `box` reach outside `panel`? An empty box paints nothing and is inside; no panel box holds nothing. */
export function escapes(box: Box, panel: Box | null, slack: number = CONTAIN_SLACK_PX): boolean {
  if (empty(box)) return false
  if (!panel) return true
  return box.left < panel.left - slack || box.top < panel.top - slack || box.right > panel.right + slack || box.bottom > panel.bottom + slack
}

/** The smallest box around the non-empty boxes, or null. */
export function unionBox(boxes: Box[]): Box | null {
  const rs = boxes.filter((b) => !empty(b))
  if (!rs.length) return null
  return { left: Math.min(...rs.map((r) => r.left)), top: Math.min(...rs.map((r) => r.top)), right: Math.max(...rs.map((r) => r.right)), bottom: Math.max(...rs.map((r) => r.bottom)) }
}

/**
 * Can paint containment apply to an element of this computed `display`? CSS Containment: not without a principal box
 * (`contents`, `none`), not on a non-atomic inline box, not on an internal table box other than a cell, not on ruby.
 */
export function canContainPaint(display: string): boolean {
  const d = display.trim()
  if (!d || d === 'none' || d === 'contents') return false
  if (d === 'inline' || d === 'inline flow' || d === 'ruby' || d.startsWith('ruby-')) return false
  if (/^table-(row|row-group|header-group|footer-group|column|column-group)$/.test(d)) return false
  return true
}

/** Does a computed `contain` value include paint containment? */
export const hasPaintContainment = (contain: string | undefined): boolean => /\b(paint|strict|content)\b/.test(contain ?? '')

/** What happens to a root element of an edited panel: `keep` it, or make it `static` (step 2 above). */
export function rootContainment(position: string, box: Box, host: Box | null): 'keep' | 'static' {
  if (position === 'fixed') return 'static'
  if (position === 'absolute') return escapes(box, host) ? 'static' : 'keep'
  return 'keep'
}

/**
 * What happens to a fixed or absolute element inside an edited panel (not a root): `inside` the panel's box, `clipped`
 * (it reaches outside, but a paint-contained ancestor in the panel keeps it from painting there), `contain-ancestor`
 * (give that ancestor paint containment) or `static`. Without a containing ancestor its own box proves nothing: what it
 * holds may overflow it, so it is contained whatever its box.
 */
export function containmentFor(el: { position: string; box: Box; clipped: boolean; containable: boolean }, panel: Box | null): 'inside' | 'clipped' | 'contain-ancestor' | 'static' {
  if (el.position !== 'fixed' && el.position !== 'absolute') return 'inside'
  if (el.clipped) return escapes(el.box, panel) ? 'clipped' : 'inside'
  return el.containable ? 'contain-ancestor' : 'static'
}

function setImportant(el: HTMLElement, prop: string, value: string): void {
  // only on a change: the observer watches `style`, and an unchanged pass must not wake it again
  if (el.style.getPropertyValue(prop) === value && el.style.getPropertyPriority(prop) === 'important') return
  el.style.setProperty(prop, value, 'important')
}

export interface ContainResult {
  /** The panel's root elements. */
  roots: number
  /** Fixed and absolute elements found reaching outside the panel's box or made static (all now contained). */
  contained: number
}

/** Contain what the panel under `wrapper` (the `<Dynamic>` wrapper) renders; see the top of this file. */
export function containPanel(wrapper: Element): ContainResult {
  const view = wrapper.ownerDocument?.defaultView
  if (!view) return { roots: 0, contained: 0 }
  const style = (el: Element) => view.getComputedStyle(el)
  const roots: HTMLElement[] = []
  const collect = (el: Element) => {
    for (const c of Array.from(el.children)) {
      const d = style(c).display
      if (d === 'contents') collect(c)
      else if (d !== 'none') roots.push(c as HTMLElement)
    }
  }
  collect(wrapper)
  let contained = 0
  const makeStatic = (el: HTMLElement) => {
    setImportant(el, 'position', 'static')
    el.setAttribute('data-pleatkit-contained', 'static')
    contained++
  }
  const clip = (el: HTMLElement) => {
    setImportant(el, 'contain', 'paint')
    if (!el.hasAttribute('data-pleatkit-clip')) el.setAttribute('data-pleatkit-clip', '')
  }

  // the host element that holds the panel: the wrapper's nearest ancestor with a box
  let hostEl = wrapper.parentElement
  while (hostEl && style(hostEl).display === 'contents') hostEl = hostEl.parentElement
  const host = hostEl ? hostEl.getBoundingClientRect() : null
  const rootSet = new Set<Element>(roots)
  for (const r of roots) {
    const s = style(r)
    if (rootContainment(s.position, r.getBoundingClientRect(), host) === 'static') makeStatic(r)
    if (canContainPaint(s.display) && !hasPaintContainment(s.contain)) clip(r)
  }

  const panel = unionBox(roots.map((r) => r.getBoundingClientRect()))
  const all = wrapper.querySelectorAll('*')
  const n = Math.min(all.length, MAX_ELEMENTS)
  for (let i = 0; i < n; i++) {
    const el = all[i] as HTMLElement
    if (rootSet.has(el)) continue
    const position = style(el).position
    if (position !== 'fixed' && position !== 'absolute') continue
    let clipped = false
    let containable: HTMLElement | null = null
    for (let p = el.parentElement; p && p !== wrapper; p = p.parentElement) {
      const ps = style(p)
      if (!canContainPaint(ps.display)) continue
      if (hasPaintContainment(ps.contain)) {
        clipped = true
        break
      }
      containable ??= p
    }
    const box = el.getBoundingClientRect()
    const what = containmentFor({ position, box, clipped, containable: containable !== null }, panel)
    if (what === 'inside') {
      if (el.getAttribute('data-pleatkit-contained') === 'clip') el.removeAttribute('data-pleatkit-contained')
    } else if (what === 'clipped') {
      if (el.getAttribute('data-pleatkit-contained') !== 'clip') el.setAttribute('data-pleatkit-contained', 'clip')
      contained++
    } else if (what === 'contain-ancestor' && containable) {
      clip(containable)
      if (escapes(box, panel)) {
        el.setAttribute('data-pleatkit-contained', 'clip')
        contained++
      }
    } else makeStatic(el)
  }
  return { roots: roots.length, contained }
}

/**
 * DECISIONS 82.4 + 84.4: while a panel runs an edit, cap its z-index and contain it, now and after any change of its
 * elements, classes or styles. Returns the function that stops watching.
 */
export function watchEditedPanel(wrapper: Element): () => void {
  return watchPanel(wrapper, () => {
    containPanel(wrapper)
    capZIndex(wrapper)
  })
}
