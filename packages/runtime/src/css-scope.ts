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
 * wins over it, and the zone's own `.css` rules are already confined to the panels with `@scope` at compile.
 */
export function layeredCss(css: string): string {
  if (!css.trim()) return ''
  // registrations and imports stay at the top level
  const top: string[] = []
  const inner: string[] = []
  for (const block of topLevelBlocks(css)) (/^@(property|import|charset)\b/i.test(block) ? top : inner).push(block)
  return [...top, `@layer pleatkit-edits {\n${inner.join('\n')}\n}`].join('\n') + '\n'
}
