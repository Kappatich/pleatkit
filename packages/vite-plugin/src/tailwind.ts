import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

/** At-rules of the app's CSS entry that the runtime Tailwind compiler needs to produce the same utilities. */
const KEEP = ['@theme', '@utility', '@custom-variant']

/**
 * Pull `@theme`, `@utility` and `@custom-variant` blocks out of the app's Tailwind entry CSS. Everything else
 * (preflight, base styles, `@source`, `@plugin`, plain rules) is already in the app's CSS or cannot run in the browser.
 */
export function extractTailwindBlocks(css: string): string[] {
  const out: string[] = []
  let i = 0
  const n = css.length
  while (i < n) {
    const ch = css[i]!
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    if (ch === '"' || ch === "'") {
      i = skipString(css, i)
      continue
    }
    if (ch === '@' && KEEP.some((k) => css.startsWith(k, i) && /[\s({;]/.test(css[i + k.length] ?? ''))) {
      const start = i
      // statement form: `@custom-variant dark (&:where(.dark, .dark *));`
      let j = i
      while (j < n && css[j] !== '{' && css[j] !== ';') j = css[j] === '"' || css[j] === "'" ? skipString(css, j) : j + 1
      if (css[j] === ';') {
        out.push(css.slice(start, j + 1).trim())
        i = j + 1
        continue
      }
      const end = matchBrace(css, j)
      out.push(css.slice(start, end + 1).trim())
      i = end + 1
      continue
    }
    if (ch === '{') {
      // skip unrelated blocks entirely (rules, @layer, @media ...)
      i = matchBrace(css, i) + 1
      continue
    }
    i++
  }
  return out
}

function skipString(css: string, i: number): number {
  const q = css[i]
  let j = i + 1
  while (j < css.length && css[j] !== q) j += css[j] === '\\' ? 2 : 1
  return j + 1
}

function matchBrace(css: string, open: number): number {
  let depth = 0
  for (let j = open; j < css.length; j++) {
    const c = css[j]
    if (c === '"' || c === "'") {
      j = skipString(css, j) - 1
      continue
    }
    if (c === '/' && css[j + 1] === '*') {
      const end = css.indexOf('*/', j + 2)
      j = end === -1 ? css.length : end + 1
      continue
    }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return j
  }
  return css.length - 1
}

export const TAILWIND_STYLESHEETS = ['tailwindcss/theme.css', 'tailwindcss/utilities.css'] as const

/** Input CSS of the runtime Tailwind compiler: theme and utilities layers plus the app's own blocks. */
export function tailwindInput(root: string, entry: string): string {
  const entryPath = path.join(root, entry)
  const blocks = fs.existsSync(entryPath) ? extractTailwindBlocks(fs.readFileSync(entryPath, 'utf8')) : []
  return [
    '@layer theme, base, components, utilities;',
    '@import "tailwindcss/theme.css" layer(theme);',
    '@import "tailwindcss/utilities.css" layer(utilities);',
    ...blocks,
  ].join('\n')
}

/** Source of `virtual:morphkit/tailwind`: the compiler, the input CSS and the stylesheets it imports. */
export function generateTailwindModule(root: string, entry: string): string {
  const req = createRequire(path.join(root, 'package.json'))
  const stylesheets: Record<string, string> = {}
  for (const id of TAILWIND_STYLESHEETS) stylesheets[id] = fs.readFileSync(req.resolve(id), 'utf8')
  const input = tailwindInput(root, entry)
  return [
    `export { compile } from 'tailwindcss'`,
    `import manifest from 'virtual:morphkit/manifest'`,
    `export const input = ${JSON.stringify(input)}`,
    `export const stylesheets = ${JSON.stringify(stylesheets)}`,
    // Readonly sources (shadcn components) are compiled with the edit so cascade order matches Tailwind's.
    `export const extraSources = manifest.readonly.map((f) => f.source)`,
  ].join('\n')
}
