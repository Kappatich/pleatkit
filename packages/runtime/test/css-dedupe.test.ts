import { describe, expect, it } from 'vitest'
import { layeredCss, pageStyledClasses, selectorClasses, unescapeCssIdent, withoutStyledRules } from '../src/css-scope.js'

// Stage 5 block 4: the edits' layer comes after the host's Tailwind layers, so a second copy of a utility the host
// already has (`.hidden`) beat the host's `md:block` on shadcn-admin's sidebar and hid it after every commit.
const EDIT_CSS = `@property --tw-font-weight { syntax: "*"; inherits: false; }
@layer theme {
  :root, :host { --color-red-600: oklch(57.7% 0.245 27.325); }
}
@layer utilities {
  .hidden { display: none; }
  .font-bold { --tw-font-weight: 700; font-weight: 700; }
  .text-red-600 { color: var(--color-red-600); }
  .md\\:block { @media (width >= 48rem) { display: block; } }
  .hover\\:bg-red-50 { &:hover { @media (hover: hover) { background-color: red; } } }
  .\\32 xl\\:grid { @media (width >= 96rem) { display: grid; } }
  .space-y-2 { :where(& > :not(:last-child)) { margin-block-start: 8px; } }
  .group-hover\\:underline { &:is(:where(.group):hover *) { text-decoration: underline; } }
}`

describe('stage 5 block 4: utilities the page already styles are not emitted again', () => {
  it('reads class names from selectors, escapes included', () => {
    expect(unescapeCssIdent('md\\:block')).toBe('md:block')
    expect(unescapeCssIdent('\\32 xl\\:grid')).toBe('2xl:grid')
    expect(unescapeCssIdent('w-\\[120px\\]')).toBe('w-[120px]')
    expect(selectorClasses('.md\\:block')).toEqual(['md:block'])
    expect(selectorClasses('.group-hover\\:underline:is(:where(.group):hover *)')).toEqual(['group-hover:underline', 'group'])
    expect(selectorClasses(':root, :host')).toEqual([])
  })

  it('drops the rules of classes the page styles and keeps new ones, variables and registrations', () => {
    const styled = new Set(['hidden', 'md:block', 'font-bold', '2xl:grid'])
    const out = withoutStyledRules(EDIT_CSS, styled)
    expect(out).not.toMatch(/\.hidden\s*\{/)
    expect(out).not.toContain('.md\\:block')
    expect(out).not.toContain('.font-bold')
    expect(out).not.toContain('.\\32 xl\\:grid')
    expect(out).toContain('.text-red-600 { color: var(--color-red-600); }')
    expect(out).toContain('.hover\\:bg-red-50')
    expect(out).toContain('.space-y-2')
    expect(out).toContain('@property --tw-font-weight')
    expect(out).toContain('--color-red-600: oklch')
    // a rule that names a styled and a new class stays (it styles something the page does not)
    expect(out).toContain('.group-hover\\:underline')
    // still one layer of the edits, still valid nesting
    const layered = layeredCss(out)
    expect(layered).toContain('@layer pleatkit-edits {')
    expect(layered.split('{').length).toBe(layered.split('}').length)
  })

  it('drops an empty layer and changes nothing when the page styles nothing', () => {
    expect(withoutStyledRules('@layer utilities { .hidden { display: none; } }', new Set(['hidden'])).trim()).toBe('')
    expect(withoutStyledRules(EDIT_CSS, new Set())).toBe(EDIT_CSS)
  })

  it('keeps the zone CSS that is scoped to the panels', () => {
    const zone = '@scope ([data-pleatkit-id]) {\n.card { color: red }\n}'
    expect(withoutStyledRules(zone, new Set(['card']))).toBe(zone)
  })

  it('collects the classes of the page, not of the edits, skipping unreadable sheets', () => {
    const owner = (attr: string | null) => ({ getAttribute: (n: string) => (n === 'data-pleatkit-css' ? attr : null) })
    const doc = {
      styleSheets: [
        {
          ownerNode: owner(null),
          cssRules: [{ cssRules: [{ selectorText: '.hidden' }, { selectorText: '.md\\:block', cssRules: [{ cssRules: [] }] }] }],
        },
        { ownerNode: owner('default'), cssRules: [{ selectorText: '.text-red-600' }] },
        {
          ownerNode: owner(null),
          get cssRules(): never {
            throw new Error('SecurityError: cross-origin')
          },
        },
      ],
    }
    const classes = pageStyledClasses(doc)
    expect([...classes].sort()).toEqual(['hidden', 'md:block'])
    expect(pageStyledClasses(undefined).size).toBe(0)
  })
})

describe('stage 5 block 5: the zone own CSS stays unlayered (found by a blind install)', () => {
  it('@scope ([data-pleatkit-id]) blocks are outside the edits layer, utilities inside it', () => {
    const css = '@scope ([data-pleatkit-id]) {\n._stats_1 { margin-bottom: 24px }\n}\n@layer utilities { .p-2 { padding: 8px } }'
    const out = layeredCss(css)
    expect(out.indexOf('@scope ([data-pleatkit-id])')).toBeLessThan(out.indexOf('@layer pleatkit-edits'))
    expect(out).toContain('@layer pleatkit-edits {\n@layer utilities')
    const onlyOwn = layeredCss('@scope ([data-pleatkit-id]) {\n.a { color: red }\n}')
    expect(onlyOwn).not.toContain('@layer pleatkit-edits')
  })
})
