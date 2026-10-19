// CSS of edits, kept away from the host app (code review 06 item 9). No dependencies: the loader and the
// isolated host use it too.

/** At-rules that must stay at the top level of a stylesheet (they cannot live inside `@scope`). */
const HOISTED_AT_RULES = /^@(-webkit-)?(keyframes|font-face|property|charset|import|layer\s+[\w.,\s-]+;|counter-style|font-feature-values)/i

/** Top-level statements of a stylesheet (brace-balanced, strings and comments respected well enough for esbuild output). */
export function topLevelBlocks(css: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  let quote: string | null = null
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]!
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end === -1 ? css.length : end + 1
    } else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        out.push(css.slice(start, i + 1).trim())
        start = i + 1
      }
    } else if (ch === ';' && depth === 0) {
      out.push(css.slice(start, i + 1).trim())
      start = i + 1
    }
  }
  const rest = css.slice(start).trim()
  if (rest) out.push(rest)
  return out.filter((b) => b && !/^\/\*[\s\S]*\*\/$/.test(b))
}

/**
 * CSS from `.css` files of the dynamic zone, scoped to the panels (code review 06 item 9): inside
 * `@scope ([data-pleatkit-id])` a selector such as `body` or `.mk-root` matches nothing outside a panel, so an edit
 * cannot restyle the host app or hide pleatkit's own buttons. Keyframes and font faces stay at the top level.
 */
export function scopeZoneCss(css: string): string {
  if (!css.trim()) return ''
  const hoisted: string[] = []
  const scoped: string[] = []
  for (const block of topLevelBlocks(css)) (HOISTED_AT_RULES.test(block) ? hoisted : scoped).push(block)
  return [...hoisted, scoped.length ? `@scope ([data-pleatkit-id]) {\n${scoped.join('\n')}\n}` : ''].filter(Boolean).join('\n') + '\n'
}

/**
 * The edits' CSS goes into its own cascade layer (code review 06 item 9): unlayered CSS of the host app always
 * wins over it, and the zone's own `.css` rules are already confined to the panels with `@scope` at compile. The
 * layer comes after the host's own layers (Tailwind 4's `@layer utilities`), so it wins over those: `applyCss` first
 * drops the utilities the page already styles (`withoutStyledRules`).
 */
export function layeredCss(css: string): string {
  if (!css.trim()) return ''
  // registrations and imports stay at the top level
  const top: string[] = []
  const inner: string[] = []
  // stage 5 block 5 (found by a blind install): the zone's own stylesheets (its .css files and CSS modules, confined to
  // the panels with `@scope ([data-pleatkit-id])` at compile) stay unlayered, as they are in the release: inside the
  // layer the host's unlayered reset (`* { margin: 0 }`) beat them, and every panel lost its margins after any edit
  const own = /^@scope\s*\(\[data-pleatkit-id\]\)/
  for (const block of topLevelBlocks(css)) (/^@(property|import|charset)\b/i.test(block) || own.test(block) ? top : inner).push(block)
  return [...top, ...(inner.length ? [`@layer pleatkit-edits {\n${inner.join('\n')}\n}`] : [])].join('\n') + '\n'
}

// --- Stage 5 block 4: utilities the page already styles are not emitted again ---
//
// The edits' layer is declared after the host's layers, so it wins over them. Tailwind 4 puts the host's utilities
// in `@layer utilities` too, and a second copy of a utility the host already has (`.hidden`) then beats the host's
// own variants on elements that are not part of any edit (`hidden md:block` on shadcn-admin's sidebar: every commit
// hid the sidebar; found by the visual judge). The page's stylesheets already style those classes in Tailwind's own
// order, so the edits' CSS keeps only the utilities the page does not have.

// eslint-disable-next-line no-control-regex -- any non-ASCII character is part of an identifier
const CLASS_TOKEN = /\.((?:\\[0-9a-fA-F]{1,6}\s?|\\[^0-9a-fA-F\n]|[\w-]|[^\u0000-\u007f])+)/g

/** `md\:block` → `md:block`, `\32 xl` → `2xl`: a class name as written in markup. */
export function unescapeCssIdent(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_m, hex: string | undefined, ch: string | undefined) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch!))
}

/** Class names a selector list mentions. */
export function selectorClasses(selector: string): string[] {
  return [...selector.matchAll(CLASS_TOKEN)].map((m) => unescapeCssIdent(m[1]!))
}

const CONTAINER = /^@(layer|media|supports|container)\b[^{;]*\{/i

/**
 * The edits' CSS without the style rules whose selector names only classes the page already styles. Rules inside
 * `@layer`, `@media`, `@supports` and `@container` blocks are filtered too (empty blocks are dropped); other rules
 * (`@property`, `@keyframes`, `@scope` of the zone's own CSS, `:root` variables) are kept as they are.
 */
export function withoutStyledRules(css: string, styled: ReadonlySet<string>): string {
  if (!styled.size || !css.trim()) return css
  const out: string[] = []
  for (const block of topLevelBlocks(css)) {
    const open = block.indexOf('{')
    if (CONTAINER.test(block) && block.endsWith('}')) {
      const inner = withoutStyledRules(block.slice(open + 1, -1), styled)
      if (inner.trim()) out.push(`${block.slice(0, open + 1)}\n${inner}\n}`)
      continue
    }
    if (open > 0 && !block.startsWith('@')) {
      const classes = selectorClasses(block.slice(0, open))
      if (classes.length && classes.every((c) => styled.has(c))) continue
    }
    out.push(block)
  }
  return out.join('\n')
}

interface RuleLike {
  selectorText?: string
  cssRules?: ArrayLike<RuleLike>
}

/** Every class the page's own stylesheets style (not the edits' `<style data-pleatkit-css>`; unreadable sheets are skipped). */
export function pageStyledClasses(page: unknown = (globalThis as { document?: unknown }).document): Set<string> {
  const doc = page as { styleSheets: ArrayLike<{ ownerNode?: unknown; cssRules?: ArrayLike<RuleLike> }> } | undefined
  const out = new Set<string>()
  if (!doc) return out
  const walk = (rules: ArrayLike<RuleLike> | undefined, depth: number) => {
    if (!rules || depth > 8) return
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i]!
      if (typeof r.selectorText === 'string') for (const c of selectorClasses(r.selectorText)) out.add(c)
      walk(r.cssRules, depth + 1)
    }
  }
  for (let i = 0; i < doc.styleSheets.length; i++) {
    const sheet = doc.styleSheets[i]!
    const owner = sheet.ownerNode as { getAttribute?: (n: string) => string | null } | null | undefined
    if (owner?.getAttribute?.('data-pleatkit-css') != null) continue
    let rules: ArrayLike<RuleLike> | undefined
    try {
      rules = sheet.cssRules
    } catch {
      continue // a cross-origin stylesheet
    }
    walk(rules, 0)
  }
  return out
}
