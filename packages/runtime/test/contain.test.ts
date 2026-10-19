import { describe, expect, it } from 'vitest'
import { canContainPaint, containmentFor, containPanel, escapes, hasPaintContainment, rootContainment, unionBox, type Box } from '../src/contain.js'

// jsdom has no layout: a tiny stand-in DOM with a computed display/position/contain, an inline style and a stubbed box
interface Spec {
  display?: string
  position?: string
  contain?: string
  box?: Box
  children?: Spec[]
}
interface Fake {
  computed: Required<Omit<Spec, 'children' | 'box'>>
  box: Box
  attrs: Map<string, string>
  inline: Map<string, { value: string; priority: string }>
  style: { setProperty(k: string, v: string, p?: string): void; getPropertyValue(k: string): string; getPropertyPriority(k: string): string }
  children: Fake[]
  parentElement: Fake | null
  ownerDocument: { defaultView: unknown }
  getBoundingClientRect(): Box
  setAttribute(k: string, v: string): void
  getAttribute(k: string): string | null
  hasAttribute(k: string): boolean
  removeAttribute(k: string): void
  querySelectorAll(sel: string): Fake[]
}

const B = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom })
const VIEWPORT = B(0, 0, 1280, 800)

function build(spec: Spec, parent: Fake | null, doc: { defaultView: unknown }): Fake {
  const inline = new Map<string, { value: string; priority: string }>()
  const attrs = new Map<string, string>()
  const el: Fake = {
    computed: { display: spec.display ?? 'block', position: spec.position ?? 'static', contain: spec.contain ?? 'none' },
    box: spec.box ?? B(0, 0, 0, 0),
    attrs,
    inline,
    style: {
      setProperty: (k, v, p = '') => void inline.set(k, { value: v, priority: p }),
      getPropertyValue: (k) => inline.get(k)?.value ?? '',
      getPropertyPriority: (k) => inline.get(k)?.priority ?? '',
    },
    children: [],
    parentElement: parent,
    ownerDocument: doc,
    getBoundingClientRect: () => el.box,
    setAttribute: (k, v) => void attrs.set(k, v),
    getAttribute: (k) => attrs.get(k) ?? null,
    hasAttribute: (k) => attrs.has(k),
    removeAttribute: (k) => void attrs.delete(k),
    querySelectorAll: () => {
      const out: Fake[] = []
      const walk = (e: Fake) => e.children.forEach((c) => (out.push(c), walk(c)))
      walk(el)
      return out
    },
  }
  el.children = (spec.children ?? []).map((c) => build(c, el, doc))
  return el
}

/** host (the element holding the panel) > wrapper (`display: contents`) > the panel's roots */
function panel(roots: Spec[], host: Box = B(300, 100, 1000, 700)) {
  const view = {
    getComputedStyle: (e: Fake) => {
      const v = (k: 'display' | 'position' | 'contain') => e.inline.get(k)?.value ?? e.computed[k]
      return { display: v('display'), position: v('position'), contain: v('contain'), zIndex: 'auto' }
    },
  }
  const doc = { defaultView: view }
  const hostEl = build({ box: host, children: [{ display: 'contents', children: roots }] }, null, doc)
  const wrapper = hostEl.children[0]!
  return { wrapper, root: (i = 0) => wrapper.children[i]!, asElement: wrapper as unknown as Element }
}

describe('DECISIONS 84.4: the decision logic of containing an edit in its panel', () => {
  it('escapes: a box reaching outside the panel, with a pixel of slack; an empty box paints nothing', () => {
    const p = B(100, 100, 400, 300)
    expect(escapes(B(100, 100, 400, 300), p)).toBe(false)
    expect(escapes(B(99.5, 100, 400.5, 300), p)).toBe(false)
    expect(escapes(VIEWPORT, p)).toBe(true) // fixed; inset: 0
    expect(escapes(B(-99999, -99999, -99000, -99000), p)).toBe(true) // absolute with huge negative offsets
    expect(escapes(B(150, 290, 200, 320), p)).toBe(true) // a dropdown below the panel's edge
    expect(escapes(B(50, 50, 50, 50), p)).toBe(false)
    expect(escapes(B(150, 150, 200, 200), null)).toBe(true) // no panel box holds nothing
  })

  it('unionBox: the panel box of several roots, ignoring empty ones', () => {
    expect(unionBox([B(10, 10, 50, 50), B(0, 0, 0, 0), B(40, 60, 90, 80)])).toEqual(B(10, 10, 90, 80))
    expect(unionBox([B(5, 5, 5, 9)])).toBeNull()
  })

  it('canContainPaint follows CSS Containment: not contents, inline, internal table boxes other than a cell, or ruby', () => {
    for (const d of ['block', 'flex', 'grid', 'inline-block', 'inline-flex', 'flow-root', 'list-item', 'table', 'table-cell']) expect(canContainPaint(d)).toBe(true)
    for (const d of ['contents', 'none', 'inline', 'table-row', 'table-row-group', 'ruby', '']) expect(canContainPaint(d)).toBe(false)
    expect(hasPaintContainment('paint')).toBe(true)
    expect(hasPaintContainment('layout paint')).toBe(true)
    expect(hasPaintContainment('strict')).toBe(true)
    expect(hasPaintContainment('none')).toBe(false)
    expect(hasPaintContainment('layout')).toBe(false)
  })

  it('rootContainment: a fixed root is always taken out of positioning; an absolute one only when it leaves the host', () => {
    const host = B(300, 100, 1000, 700)
    expect(rootContainment('fixed', B(400, 200, 500, 300), host)).toBe('static')
    expect(rootContainment('absolute', B(900, 600, 990, 690), host)).toBe('keep') // a legend in the host's corner
    expect(rootContainment('absolute', B(0, 0, 1280, 800), host)).toBe('static')
    expect(rootContainment('relative', VIEWPORT, host)).toBe('keep')
    expect(rootContainment('static', VIEWPORT, host)).toBe('keep')
  })

  it('containmentFor: clipped by a contained ancestor, or contained through the nearest ancestor, or made static', () => {
    const p = B(300, 100, 1000, 400)
    expect(containmentFor({ position: 'relative', box: VIEWPORT, clipped: false, containable: false }, p)).toBe('inside')
    expect(containmentFor({ position: 'fixed', box: VIEWPORT, clipped: true, containable: true }, p)).toBe('clipped')
    expect(containmentFor({ position: 'absolute', box: B(310, 110, 400, 200), clipped: true, containable: true }, p)).toBe('inside')
    // not inside any containment: its box proves nothing (what it holds may overflow it)
    expect(containmentFor({ position: 'absolute', box: B(310, 110, 400, 200), clipped: false, containable: true }, p)).toBe('contain-ancestor')
    expect(containmentFor({ position: 'fixed', box: B(0, 0, 0, 0), clipped: false, containable: false }, p)).toBe('static')
  })
})

describe('DECISIONS 84.4: containPanel on an edited panel', () => {
  it('gives the root paint containment and marks the fixed and absolute elements that reach outside the panel', () => {
    const { wrapper, root, asElement } = panel([
      {
        box: B(300, 100, 1000, 400),
        children: [
          { box: B(320, 120, 600, 140) }, // the name
          { position: 'fixed', box: VIEWPORT }, // inset: 0
          { position: 'absolute', box: B(-99999, -99999, -90000, -90000) },
          { position: 'absolute', box: B(900, 110, 990, 130) }, // a badge in the card's corner
        ],
      },
    ])
    const r = containPanel(asElement)
    expect(r).toEqual({ roots: 1, contained: 2 })
    expect(root().style.getPropertyValue('contain')).toBe('paint')
    expect(root().style.getPropertyPriority('contain')).toBe('important')
    expect(root().hasAttribute('data-pleatkit-clip')).toBe(true)
    const [, fixed, far, badge] = root().children
    expect(fixed!.getAttribute('data-pleatkit-contained')).toBe('clip')
    expect(far!.getAttribute('data-pleatkit-contained')).toBe('clip')
    expect(badge!.hasAttribute('data-pleatkit-contained')).toBe(false)
    // the layout keeps the wrapper as it was: `display: contents`, nothing written on it
    expect(wrapper.inline.size).toBe(0)
    // nothing is moved: the fixed element is clipped by the root, not repositioned
    expect(fixed!.inline.has('position')).toBe(false)
  })

  it('is idempotent: a second pass writes no style (the observer watching `style` is not woken again)', () => {
    const { root, asElement } = panel([{ box: B(300, 100, 1000, 400), children: [{ position: 'fixed', box: VIEWPORT }] }])
    containPanel(asElement)
    const writes: string[] = []
    const set = root().style.setProperty
    root().style.setProperty = (k, v, p) => (writes.push(k), set(k, v, p))
    containPanel(asElement)
    expect(writes).toEqual([])
  })

  it('a fixed root, or an absolute root outside the host, is made static and then contained like any root', () => {
    const { root, asElement } = panel([
      { position: 'fixed', box: VIEWPORT, children: [{ box: B(0, 0, 1280, 40) }] },
      { position: 'absolute', box: B(900, 600, 990, 690) },
      { position: 'absolute', box: B(-5000, 0, 1280, 800) },
    ])
    const r = containPanel(asElement)
    expect(r.contained).toBe(2)
    expect(root(0).style.getPropertyValue('position')).toBe('static')
    expect(root(0).getAttribute('data-pleatkit-contained')).toBe('static')
    expect(root(0).style.getPropertyValue('contain')).toBe('paint')
    expect(root(1).inline.has('position')).toBe(false)
    expect(root(2).style.getPropertyValue('position')).toBe('static')
  })

  it('a root that cannot take paint containment (a table row): the nearest cell is contained, else the element is made static', () => {
    const { root, asElement } = panel([
      {
        display: 'table-row',
        box: B(300, 100, 1000, 140),
        children: [
          { display: 'table-cell', box: B(300, 100, 600, 140), children: [{ position: 'fixed', box: VIEWPORT }] },
          { display: 'table-cell', box: B(600, 100, 1000, 140) },
        ],
      },
      { display: 'inline', box: B(300, 140, 400, 160), children: [{ position: 'absolute', box: B(310, 142, 320, 150) }] },
    ])
    containPanel(asElement)
    expect(root(0).inline.has('contain')).toBe(false) // no effect on a row: not written
    const cell = root(0).children[0]!
    expect(cell.style.getPropertyValue('contain')).toBe('paint')
    expect(cell.children[0]!.getAttribute('data-pleatkit-contained')).toBe('clip')
    // an absolute element under an inline root: nothing can contain it, even though its own box is inside
    expect(root(1).children[0]!.style.getPropertyValue('position')).toBe('static')
    // the second pass sees the cell's containment: the fixed element is clipped by it, not contained again
    expect(containPanel(asElement).contained).toBe(1)
  })

  it('leaves an edit that already contains itself as it is, and goes through nested display: contents', () => {
    const { root, asElement } = panel([{ display: 'contents', children: [{ contain: 'strict', box: B(300, 100, 1000, 400) }] }])
    expect(containPanel(asElement).roots).toBe(1)
    expect(root().inline.size).toBe(0)
    expect(root().children[0]!.inline.has('contain')).toBe(false)
  })
})
