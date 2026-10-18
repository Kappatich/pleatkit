import type { AgentResult, FileMap } from '@pleatkit/runtime/compiler'
import type { EvalTask } from './types.js'

export interface PredicateContext {
  task: EvalTask
  result: Omit<AgentResult, 'requestId'>
  /** The user's files after the result is applied. */
  final: FileMap
  /** Only the files the result changed or added. */
  changed: FileMap
}

/** `null` when the predicate holds, otherwise why not. */
export type Predicate = (c: PredicateContext) => string | null

const CYRILLIC = /[Ѐ-ӿ]/

/** String literals and JSX text of a TSX source (comments removed): what ends up on screen. */
export function visibleStrings(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const out: string[] = []
  for (const m of code.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  for (const m of code.matchAll(/>([^<>{}]+)</g)) if (m[1]!.trim()) out.push(m[1]!.trim())
  return out
}

const NAMED_GREENS: Record<string, string> = { green: '#008000', lime: '#00ff00', limegreen: '#32cd32', seagreen: '#2e8b57', forestgreen: '#228b22', mediumseagreen: '#3cb371', springgreen: '#00ff7f', darkgreen: '#006400', emerald: '#10b981', teal: '#008080' }

/** Hue in degrees of `#rgb`, `#rrggbb`, `rgb(r, g, b)` or a few CSS green names; null when unreadable or grey. */
export function hueOf(color: string): number | null {
  const c = NAMED_GREENS[color.toLowerCase()] ?? color
  let rgb: number[] | null = null
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c)
  if (hex) {
    const h = hex[1]!.length === 3 ? hex[1]!.split('').map((x) => x + x).join('') : hex[1]!
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  }
  const fn = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(c)
  if (fn) rgb = [fn[1], fn[2], fn[3]].map(Number)
  if (!rgb) return null
  const [r, g, b] = rgb.map((x) => x / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (d === 0) return null
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

/**
 * Custom invariants a task names in `invariants.predicates`. Each one is a plain function of the run's result, so a
 * new kind of check is one entry here and one name in a task file.
 */
export const PREDICATES: Record<string, { description: string; check: Predicate }> = {
  'no-main-model-calls': {
    description: 'The big model was never called (off-topic is answered by the classifier alone, hypothesis H6).',
    check: ({ result }) => (result.modelCalls === 0 ? null : `the main loop made ${result.modelCalls} model call(s)`),
  },
  'backend-note': {
    description: 'A partial or needs-backend answer tells the administrator what the server would need.',
    check: ({ result }) => (result.backendNote?.trim() ? null : 'no backend_note for the administrator'),
  },
  'clarify-question': {
    description: 'One question with 2 to 4 options, and nothing changed.',
    check: ({ result, changed }) => {
      if (!result.clarify?.question) return 'no clarifying question'
      const n = result.clarify.options.length
      if (n < 2 || n > 4) return `${n} options (2 to 4 expected)`
      return Object.keys(changed).length ? 'files were changed while asking' : null
    },
  },
  'images-received': {
    description: 'Every screenshot of the task reached the agent.',
    check: ({ task, result }) => {
      const want = task.images?.length ?? 0
      const got = result.attachments?.images ?? 0
      return got === want ? null : `the agent got ${got} image(s), the task has ${want}`
    },
  },
  'target-dom-received': {
    description: 'The pointed panel and its DOM snapshot reached the agent.',
    check: ({ result }) => ((result.attachments?.targetDomChars ?? 0) > 0 ? null : 'no panel DOM in the request'),
  },
  'labels-in-panel-language': {
    description: 'New labels follow the panel (English), not the request (hypothesis H8).',
    check: ({ changed }) => {
      for (const [p, s] of Object.entries(changed)) {
        const bad = visibleStrings(s).find((t) => CYRILLIC.test(t))
        if (bad) return `${p}: label "${bad.slice(0, 40)}" is not in the panel's language`
      }
      return null
    },
  },
  'plain-summary': {
    description: 'The summary the user reads has no code, file names or markup.',
    check: ({ result }) => {
      const m = /src\/|\.tsx?\b|data-testid|<\/?[A-Za-z][\w.]*[\s>/]|=>|\bimport\b|className/.exec(result.summary)
      return m ? `the summary contains "${m[0]}"` : null
    },
  },
  'chart-colors-green': {
    description: 'The first colour of a chart\'s `colors: [...]` option is a green (hue 75° to 170°): hex, rgb() or a CSS name.',
    check: ({ changed }) => {
      for (const [p, s] of Object.entries(changed)) {
        const m = /colors:\s*\[\s*["'`]([^"'`]+)["'`]/.exec(s)
        if (!m) continue
        const hue = hueOf(m[1]!.trim())
        if (hue === null) return `${p}: cannot read the colour "${m[1]}"`
        return hue >= 75 && hue <= 170 ? null : `${p}: "${m[1]}" has hue ${Math.round(hue)}°, not green`
      }
      return 'no chart colours were changed'
    },
  },
  'summary-in-russian': {
    description: 'A Russian-speaking user gets the summary in Russian.',
    check: ({ result }) => (CYRILLIC.test(result.summary) ? null : 'the summary is not in Russian'),
  },
}
