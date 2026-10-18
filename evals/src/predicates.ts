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
  'summary-in-russian': {
    description: 'A Russian-speaking user gets the summary in Russian.',
    check: ({ result }) => (CYRILLIC.test(result.summary) ? null : 'the summary is not in Russian'),
  },
}
