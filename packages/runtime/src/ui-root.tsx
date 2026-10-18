import { useLayoutEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** Marks pleatkit's own interface; the element picker and the static rules (`.mk-`, `[data-pleatkit…]`) know it. */
export const UI_LAYER_ATTR = 'data-pleatkit-ui-layer'
/** `<style>` elements the pleatkit UI injects into the document head; mirrored into the shadow root. */
export const UI_STYLE_SELECTOR = 'style[data-pleatkit-ui]'

/**
 * Copy the UI stylesheets into a shadow root. Inside a shadow tree `:root` and `html` match nothing, so they are
 * rewritten to `:host`; `@font-face` keeps working because the original stays in the document head.
 */
export function mirrorUiStyles(root: ShadowRoot, doc: Document = document): () => void {
  const copies = new Map<Element, HTMLStyleElement>()
  const sync = () => {
    const sources = Array.from(doc.querySelectorAll(UI_STYLE_SELECTOR))
    for (const src of sources) {
      let copy = copies.get(src)
      if (!copy) {
        copy = doc.createElement('style')
        copy.setAttribute('data-pleatkit-ui-copy', '')
        root.prepend(copy)
        copies.set(src, copy)
      }
      // `[data-mk-theme="dark"] .mk-root` (the theme set on <html>) becomes `:host([data-mk-theme="dark"]) .mk-root`;
      // the host element carries a copy of the attribute (see PleatkitUiRoot)
      const text = (src.textContent ?? '')
        .replace(/:root\b/g, ':host')
        .replace(/(^|[\s,}])html(?=[\s,{.:[])/g, '$1:host')
        .replace(/(^|[\s,}])(\[data-mk-theme[^\]]*\])\s+/g, '$1:host($2) ')
      if (copy.textContent !== text) copy.textContent = text
    }
    for (const [src, copy] of copies) {
      if (!sources.includes(src)) {
        copy.remove()
        copies.delete(src)
      }
    }
  }
  sync()
  if (typeof MutationObserver === 'undefined') return () => undefined
  const observer = new MutationObserver(sync)
  observer.observe(doc.head, { childList: true, subtree: true, characterData: true })
  return () => observer.disconnect()
}

/**
 * Renders pleatkit's own interface (chat drawer, picker, toasts) into a shadow root attached to `<body>`
 * (code review 06 item 9): CSS of an edit, scoped or not, cannot reach it, so `.mk-root { display: none }` can
 * no longer hide the undo button. Logic only; the look comes from the UI package's stylesheet, mirrored in.
 * `shadow={false}` renders in place (light DOM), as before.
 */
export function PleatkitUiRoot({ children, shadow = true }: { children?: ReactNode; shadow?: boolean }) {
  const [root, setRoot] = useState<ShadowRoot | null>(null)
  useLayoutEffect(() => {
    if (!shadow || typeof document === 'undefined' || !document.body?.attachShadow) return
    const host = document.createElement('div')
    host.setAttribute(UI_LAYER_ATTR, '')
    host.setAttribute('data-pleatkit-ui-host', '')
    document.body.appendChild(host)
    const sr = host.attachShadow({ mode: 'open' })
    const stop = mirrorUiStyles(sr)
    // the page's theme switch (`data-mk-theme` on <html>) reaches the shadow tree through the host
    const syncTheme = () => {
      const theme = document.documentElement.getAttribute('data-mk-theme')
      if (theme === null) host.removeAttribute('data-mk-theme')
      else host.setAttribute('data-mk-theme', theme)
    }
    syncTheme()
    const themeObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(syncTheme)
    themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mk-theme'] })
    setRoot(sr)
    return () => {
      themeObserver?.disconnect()
      stop()
      host.remove()
      setRoot(null)
    }
  }, [shadow])
  if (!shadow) return <>{children}</>
  return root ? createPortal(children, root) : null
}
