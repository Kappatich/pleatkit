// State preservation across a module swap (V1 B4, minimum viable): a new version of a panel is a new component,
// so React remounts it and its local state is gone. What users notice is text they were typing and where they
// had scrolled; both are captured from the DOM right before the swap and put back right after it.

export interface PanelState {
  fields: { key: string; value: string; start: number | null; end: number | null; focused: boolean }[]
  scroll: { key: string; top: number; left: number }[]
}

const TEXT_INPUT = new Set(['', 'text', 'search', 'email', 'tel', 'url', 'number', 'password'])

type Field = HTMLInputElement | HTMLTextAreaElement

function isTextField(el: Element): el is Field {
  if (el instanceof HTMLTextAreaElement) return true
  return el instanceof HTMLInputElement && TEXT_INPUT.has((el.getAttribute('type') ?? '').toLowerCase())
}

/** A key that survives a remount: test id, name or id, else the position among elements of the same kind. */
function keyOf(el: Element, kind: string, index: number): string {
  const stable = el.getAttribute('data-testid') ?? el.getAttribute('name') ?? el.id
  return stable ? `${kind}:${stable}` : `${kind}#${index}`
}

export function capturePanel(container: Element): PanelState {
  const fields = Array.from(container.querySelectorAll('input, textarea')).filter(isTextField)
  const active = typeof document !== 'undefined' ? document.activeElement : null
  // same candidate list as restorePanel, so positional keys line up
  const candidates = Array.from(container.querySelectorAll('*')).filter((el) => el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)
  const scrollable = candidates.map((el, i) => ({ el, i })).filter(({ el }) => el.scrollTop > 0 || el.scrollLeft > 0)
  return {
    fields: fields.map((el, i) => {
      let start: number | null = null
      let end: number | null = null
      try {
        start = el.selectionStart
        end = el.selectionEnd
      } catch {
        // type=number has no selection
      }
      return { key: keyOf(el, el.tagName, i), value: el.value, start, end, focused: el === active }
    }),
    scroll: scrollable.map(({ el, i }) => ({ key: keyOf(el, 'scroll', i), top: el.scrollTop, left: el.scrollLeft })),
  }
}

/** Set a value the way typing does, so React's controlled inputs see it (their onChange runs). */
function setValue(el: Field, value: string): void {
  if (el.value === value) return
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

export function restorePanel(container: Element, state: PanelState): void {
  const fields = Array.from(container.querySelectorAll('input, textarea')).filter(isTextField)
  const byKey = new Map(fields.map((el, i) => [keyOf(el, el.tagName, i), el]))
  for (const f of state.fields) {
    const el = byKey.get(f.key)
    if (!el) continue
    setValue(el, f.value)
    if (f.focused) {
      el.focus({ preventScroll: true })
      try {
        if (f.start !== null && f.end !== null) el.setSelectionRange(f.start, f.end)
      } catch {
        // not selectable
      }
    }
  }
  if (state.scroll.length === 0) return
  const all = Array.from(container.querySelectorAll('*'))
  // scrollable elements of the new version: anything with overflow, matched by stable key, else by order
  const candidates = all.filter((el) => el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)
  const byScrollKey = new Map(candidates.map((el, i) => [keyOf(el, 'scroll', i), el]))
  for (const s of state.scroll) {
    const el = byScrollKey.get(s.key)
    if (!el) continue
    el.scrollTop = s.top
    el.scrollLeft = s.left
  }
}
