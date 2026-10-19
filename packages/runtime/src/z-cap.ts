/**
 * DECISIONS 82.4: an edit must not cover what is outside its panel. An edited panel's positioned elements (fixed,
 * absolute, sticky, relative) get their z-index capped at `EDIT_Z_INDEX_CAP`: below the host's own overlays (dialogs and
 * dropdowns of the common UI kits sit at 1000 and above) and far below pleatkit's launcher and chat (2147482000+), so a
 * full-screen element written into an edit can never hide the Undo the user needs to get rid of it. The static rules
 * keep an edit inside its panel's subtree (`no-portal`: no createPortal, nothing attached to document.body), so the
 * panel's subtree is the whole of what an edit renders. Applied only while the panel runs an edit; the release's own
 * code is the developer's and is left alone.
 */
export const EDIT_Z_INDEX_CAP = 999

/** Elements examined per pass at most (a panel is a few hundred elements; a runaway list must not stall the page). */
const MAX_ELEMENTS = 5000

/** Cap the z-index of every positioned element under `root` (the panel's wrapper); returns how many were capped. */
export function capZIndex(root: Element, cap: number = EDIT_Z_INDEX_CAP): number {
  const view = root.ownerDocument?.defaultView
  if (!view) return 0
  let capped = 0
  const all = root.querySelectorAll('*')
  const n = Math.min(all.length, MAX_ELEMENTS)
  for (let i = 0; i < n; i++) {
    const el = all[i] as HTMLElement
    const cs = view.getComputedStyle(el)
    if (!cs.position || cs.position === 'static') continue
    const z = Number.parseInt(cs.zIndex, 10)
    if (!Number.isFinite(z) || z <= cap) continue
    if (!el.hasAttribute('data-pleatkit-zcap')) el.setAttribute('data-pleatkit-zcap', String(z))
    el.style.setProperty('z-index', String(cap), 'important')
    capped++
  }
  return capped
}

/**
 * Keep capping while the panel lives: once now, and again after any change of its elements, classes or styles (an
 * edit can raise a z-index later, on hover or after a timer). Returns the function that stops watching.
 */
export function watchZIndex(root: Element, cap: number = EDIT_Z_INDEX_CAP): () => void {
  const view = root.ownerDocument?.defaultView
  if (!view) return () => undefined
  capZIndex(root, cap)
  if (typeof view.MutationObserver !== 'function') return () => undefined
  let queued = false
  const raf = typeof view.requestAnimationFrame === 'function' ? view.requestAnimationFrame.bind(view) : (f: () => void) => view.setTimeout(f, 16)
  const observer = new view.MutationObserver(() => {
    if (queued) return
    queued = true
    raf(() => {
      queued = false
      capZIndex(root, cap)
    })
  })
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class'] })
  return () => observer.disconnect()
}
