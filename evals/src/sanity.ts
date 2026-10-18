import { oracleProvider } from './providers.js'
import type { SanityResult } from './report.js'
import { runSuite, type SuiteOptions } from './runner.js'

/**
 * The sanity check of the graders (brainstorm 04 §8 item 9): every reference solution passes every grader, and the
 * null agent (writes nothing, finishes at once with the expected verdict) fails every task that requires a change.
 * A grader that lets the null agent through measures nothing; one that fails a reference is wrong.
 */
export async function runSanity(o: Omit<SuiteOptions, 'kind' | 'agent' | 'providerFor' | 'recordDir' | 'recordingOf'>): Promise<SanityResult> {
  const reference = await runSuite({ ...o, kind: 'sanity-reference', agent: 'reference', providerFor: (t) => oracleProvider(t, { write: true }) })
  const nul = await runSuite({ ...o, kind: 'sanity-null', agent: 'null', providerFor: (t) => oracleProvider(t, { write: false }) })
  return { reference, null: nul, problems: sanityProblems(o.tasks, reference, nul) }
}

export function sanityProblems(tasks: SuiteOptions['tasks'], reference: SanityResult['reference'], nul: SanityResult['null']): string[] {
  const problems: string[] = []
  for (const r of reference.runs) {
    if (!r.pass) problems.push(`reference of ${r.taskId} fails: ${r.graders.filter((g) => !g.pass).map((g) => `${g.grader} (${g.reason})`).join('; ')}`)
  }
  for (const r of nul.runs) {
    const task = tasks.find((t) => t.id === r.taskId)
    if (task?.expected.change && r.pass) problems.push(`the null agent passes ${r.taskId}, which requires a change: the graders do not notice an empty answer`)
  }
  for (const run of [reference, nul]) if (run.aborted) problems.push(`${run.kind} stopped early: ${run.aborted.reason}`)
  return problems
}
