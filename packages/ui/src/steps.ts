import type { AgentProgress } from '@morphkit/runtime'

/** One progress line in a chat turn. */
export interface Step {
  text: string
  tone?: 'good' | 'bad'
  /** "Thinking" between tool calls: replaced by whatever comes next (DECISIONS item 19). */
  transient?: boolean
  /** How many identical lines in a row this one stands for. */
  count?: number
}

/** At most this many lines are visible; the rest is behind a "details" toggle (DECISIONS item 19). */
export const MAX_VISIBLE_STEPS = 6

/**
 * Append a progress event to a turn's steps:
 * - a transient line ("Thinking") is replaced by the next line, so there is never more than one in a row,
 *   and it only stays while the agent is actually thinking;
 * - a line identical to the previous one is collapsed into it (`count`), check results included.
 */
export function addStep(steps: readonly Step[], p: AgentProgress): Step[] {
  const next: Step = {
    text: p.text,
    ...(p.type === 'check' ? { tone: p.ok ? ('good' as const) : ('bad' as const) } : {}),
    ...(p.type === 'model' && p.transient ? { transient: true } : {}),
  }
  const out = steps.slice()
  if (out.at(-1)?.transient) out.pop()
  const last = out.at(-1)
  if (last && last.text === next.text && last.tone === next.tone) {
    // a repeated "Thinking" stays a single, uncounted line
    if (!next.transient) out[out.length - 1] = { ...last, count: (last.count ?? 1) + 1 }
    return out
  }
  out.push(next)
  return out
}

/** The steps to show: everything when expanded, otherwise the last `max` lines and how many are hidden. */
export function visibleSteps(steps: readonly Step[], expanded: boolean, max = MAX_VISIBLE_STEPS): { shown: Step[]; hidden: number } {
  if (expanded || steps.length <= max) return { shown: steps.slice(), hidden: 0 }
  return { shown: steps.slice(steps.length - max), hidden: steps.length - max }
}
