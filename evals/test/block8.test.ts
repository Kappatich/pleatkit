import { describe, expect, it } from 'vitest'
import { byokDefaultRule, disagreements, matrixRow } from '../src/matrix.js'
import type { SuiteResult, TaskRun } from '../src/types.js'

const run = (taskId: string, pass: boolean, o: Partial<TaskRun> = {}): TaskRun => ({
  taskId,
  title: taskId,
  agent: 'live',
  expectedVerdict: 'ok',
  verdict: pass ? 'ok' : 'failed',
  summary: '',
  changedFiles: ['src/dynamic/x.tsx'],
  modelCalls: 1,
  firstTry: true,
  costUsd: 0.01,
  unpricedModels: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  model: 'm',
  ms: 5000,
  graders: [{ grader: 'verdict', pass, reason: '' }],
  pass,
  ...o,
})
const suite = (runs: TaskRun[]): SuiteResult =>
  ({ kind: 'record', startedAt: '', finishedAt: '', prompt: { version: 'x', prefixChars: 0, prefixTokens: 0 }, budget: { capUsd: 2, spentUsd: 0 }, browser: 'skipped', typecheck: 'ran', runs }) as SuiteResult

/** Three trials of one task per suite; `fails` names the runs that fail (`aw-01-x.t2`). */
const three = (model: string, fails: string[] = [], o: Partial<TaskRun> = {}) =>
  suite(
    ['crm-01-a', 'sa-01-b', 'aw-01-c'].flatMap((t) => [1, 2, 3].map((trial) => run(t, !fails.includes(`${t}.t${trial}`), { trial, model, ...o }))),
  )

describe('stage 5 block 8: Sonnet against Haiku, three trials each', () => {
  it('counts every trial per task and lists the tasks the two sets pass a different number of times', () => {
    const a = matrixRow('a', three('sonnet'), null)
    const b = matrixRow('b', three('haiku', ['aw-01-c.t2', 'sa-01-b.t1']), null)
    expect(a.perTask).toEqual({ 'crm-01': [3, 3], 'sa-01': [3, 3], 'aw-01': [3, 3] })
    expect(b.pass.all).toEqual([7, 9])
    expect(disagreements(a, b)).toEqual([
      { task: 'aw-01', a: [3, 3], b: [2, 3] },
      { task: 'sa-01', a: [3, 3], b: [2, 3] },
    ])
    expect(disagreements(a, a)).toEqual([])
  })

  it('the BYOK default rule: every set within 1 point, first try within 3, p95 under 12 s; better than the reference is fine', () => {
    const ref = matrixRow('ref', three('sonnet'), null)
    expect(byokDefaultRule(ref, matrixRow('same', three('haiku'), null)).switch).toBe(true)
    // one failed trial of three on one set: 33 points down on it
    const oneFail = byokDefaultRule(ref, matrixRow('f', three('haiku', ['aw-01-c.t1']), null))
    expect(oneFail.switch).toBe(false)
    expect(oneFail.checks.filter((c) => !c.ok).map((c) => c.what)).toEqual(['pass awkward (points)'])
    // slower: p95 at 12 s is not under 12 s
    const slow = byokDefaultRule(ref, matrixRow('s', three('haiku', [], { ms: 12_000 }), null))
    expect(slow.checks.find((c) => c.what.startsWith('edit latency'))).toMatchObject({ candidate: 12_000, ok: false })
    // first try 8/9 (88.9) against 9/9: 11 points down
    const retry = three('haiku')
    retry.runs[0]!.firstTry = false
    expect(byokDefaultRule(ref, matrixRow('r', retry, null)).checks.find((c) => c.what.startsWith('first try'))!.ok).toBe(false)
    // the reference worse than the candidate: the one-sided rule passes
    expect(byokDefaultRule(matrixRow('w', three('sonnet', ['crm-01-a.t1']), null), ref).switch).toBe(true)
  })
})
