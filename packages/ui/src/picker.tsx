import { useEffect, useState } from 'react'

interface Box {
  id: string
  top: number
  left: number
  width: number
  height: number
}

/** `<Dynamic>` wrappers use `display: contents`, so their box is the union of their children's boxes. */
export function panelRect(el: Element): DOMRect | null {
  const own = el.getBoundingClientRect()
  if (own.width > 0 || own.height > 0) return own
  let top = Infinity
  let left = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const child of Array.from(el.children)) {
    const r = panelRect(child)
    if (!r || (r.width === 0 && r.height === 0)) continue
    top = Math.min(top, r.top)
    left = Math.min(left, r.left)
    right = Math.max(right, r.right)
    bottom = Math.max(bottom, r.bottom)
  }
  return top === Infinity ? null : new DOMRect(left, top, right - left, bottom - top)
}

/** The nearest `<Dynamic>` panel under the pointer, ignoring pleatkit's own UI. */
export function panelAt(x: number, y: number): Element | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el.closest('[data-pleatkit-ui-layer]')) continue
    const panel = el.closest('[data-pleatkit-id]')
    if (panel) return panel
  }
  return null
}

/**
 * "Point at the screen": highlights the panel under the pointer; a click picks it. A transparent layer
 * catches the click so the app underneath does not react. Escape cancels.
 */
export function ElementPicker({ onPick, onCancel, hint = 'Click a panel to mention it · Esc to cancel' }: { onPick: (id: string) => void; onCancel: () => void; hint?: string }) {
  const [box, setBox] = useState<Box | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const locate = (x: number, y: number): Box | null => {
    const panel = panelAt(x, y)
    const r = panel && panelRect(panel)
    const id = panel?.getAttribute('data-pleatkit-id')
    return r && id ? { id, top: r.top, left: r.left, width: r.width, height: r.height } : null
  }

  return (
    <div data-pleatkit-ui-layer="" className="mk-root">
      <div className="mk-pick-hint">{hint}</div>
      <div
        className="mk-pick-layer"
        data-testid="mk-pick-layer"
        onMouseMove={(e) => setBox(locate(e.clientX, e.clientY))}
        onMouseLeave={() => setBox(null)}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const hit = locate(e.clientX, e.clientY)
          if (hit) onPick(hit.id)
          else onCancel()
        }}
      />
      {box && (
        <div className="mk-pick-box" data-testid="mk-pick-box" data-panel={box.id} style={{ top: box.top - 4, left: box.left - 4, width: box.width + 8, height: box.height + 8 }}>
          <span className="mk-pick-label">{box.id}</span>
        </div>
      )}
    </div>
  )
}
