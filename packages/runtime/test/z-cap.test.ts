import { describe, expect, it } from 'vitest'
import { capZIndex, EDIT_Z_INDEX_CAP } from '../src/z-cap.js'

/** A tiny stand-in for a panel's DOM: elements with a computed position and z-index, and an inline style. */
function fakePanel(items: { position: string; zIndex: string }[]) {
  const els = items.map((s) => {
    const attrs = new Map<string, string>()
    const style = new Map<string, string>()
    return {
      computed: s,
      attrs,
      style: { setProperty: (k: string, v: string) => void style.set(k, v), get: (k: string) => style.get(k) },
      setAttribute: (k: string, v: string) => void attrs.set(k, v),
      hasAttribute: (k: string) => attrs.has(k),
    }
  })
  const view = {
    getComputedStyle: (el: (typeof els)[number]) => {
      const inline = el.style.get('z-index')
      return { position: el.computed.position, zIndex: inline ?? el.computed.zIndex }
    },
  }
  const root = { ownerDocument: { defaultView: view }, querySelectorAll: () => els }
  return { root: root as unknown as Element, els }
}

describe('DECISIONS 82.4: the z-index cap of an edited panel', () => {
  it('caps positioned elements above the cap and remembers the value they asked for', () => {
    const { root, els } = fakePanel([
      { position: 'fixed', zIndex: '2147483647' },
      { position: 'absolute', zIndex: '5000' },
      { position: 'relative', zIndex: '10' },
      { position: 'static', zIndex: '99999' },
      { position: 'sticky', zIndex: 'auto' },
    ])
    expect(capZIndex(root)).toBe(2)
    expect(els[0]!.style.get('z-index')).toBe(String(EDIT_Z_INDEX_CAP))
    expect(els[0]!.attrs.get('data-pleatkit-zcap')).toBe('2147483647')
    expect(els[1]!.style.get('z-index')).toBe(String(EDIT_Z_INDEX_CAP))
    expect(els[2]!.style.get('z-index')).toBeUndefined()
    expect(els[3]!.style.get('z-index')).toBeUndefined() // static: z-index does not apply
    expect(els[4]!.style.get('z-index')).toBeUndefined()
  })

  it('is idempotent (a second pass after its own style change caps nothing) and stays far below the launcher', () => {
    const { root } = fakePanel([{ position: 'fixed', zIndex: '2147483647' }])
    expect(capZIndex(root)).toBe(1)
    expect(capZIndex(root)).toBe(0)
    // pleatkit's launcher sits at 2147482000 (packages/ui styles); host overlays of the common kits at 1000+
    expect(EDIT_Z_INDEX_CAP).toBeLessThan(1000)
  })
})
