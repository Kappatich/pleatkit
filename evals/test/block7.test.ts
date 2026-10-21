import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cheapestPerFamily, FAMILY_OF, familyOf, markdown, matrixRow, mergeSuites, suiteOf } from '../src/matrix.js'
import { belowMinPass } from '../src/runner.js'
import { hasSuite, SUITES } from '../src/tasks.js'
import type { SuiteResult, TaskRun } from '../src/types.js'

const run = (taskId: string, pass: boolean, o: Partial<TaskRun> = {}): TaskRun => ({
  taskId,
  title: taskId,
  agent: 'live',
  expectedVerdict: 'ok',
  verdict: pass ? 'ok' : 'failed',
  summary: '',
  changedFiles: pass ? ['src/dynamic/x.tsx'] : [],
  modelCalls: 1,
  firstTry: pass ? true : null,
  costUsd: 0.01,
  unpricedModels: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  model: 'm',
  ms: 5000,
  graders: [{ grader: 'verdict', pass, reason: '' }],
  pass,
  ...o,
})
const suite = (runs: TaskRun[], aborted?: SuiteResult['aborted']): SuiteResult =>
  ({ kind: 'record', startedAt: '', finishedAt: '', prompt: { version: 'x', prefixChars: 0, prefixTokens: 0 }, budget: { capUsd: 2, spentUsd: 0 }, browser: 'skipped', typecheck: 'ran', runs, ...(aborted ? { aborted } : {}) }) as SuiteResult

describe('stage 5 block 7: the model matrix', () => {
  it('every task of demo, apps and awkward has exactly one family', () => {
    const ids = (['demo', 'apps', 'awkward'] as const).filter(hasSuite).flatMap((s) =>
      fs
        .readdirSync(SUITES[s])
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, '')),
    )
    // the apps and awkward suites are private (PLEATKIT_PRIVATE_EVALS): the demo's 14 alone without them
    expect(ids).toHaveLength(hasSuite('apps') && hasSuite('awkward') ? 69 : 14)
    for (const id of ids) expect(familyOf(id), id).toBeDefined()
    expect(Object.keys(FAMILY_OF)).toHaveLength(69)
    expect(suiteOf('crm-01-card-fields')).toBe('demo')
    expect(suiteOf('aw-03-like-before')).toBe('awkward')
    expect(suiteOf('ta-06-sales-line-chart')).toBe('apps')
  })

  it('--min-pass stops only at its run count and only below its rate (the in-process graders, before the browser)', () => {
    const mp = { rate: 0.7, after: 20 }
    expect(belowMinPass(undefined, 0, 20)).toBeNull()
    expect(belowMinPass(mp, 13, 19)).toBeNull()
    expect(belowMinPass(mp, 14, 20)).toBeNull()
    expect(belowMinPass(mp, 13, 20)).toContain('13 of the first 20')
    expect(belowMinPass(mp, 0, 21)).toBeNull()
  })

  it('takes the pass from the graded replay and the latency and cost from the live record', () => {
    const record = suite([run('crm-01-card-fields', true, { ms: 4000, costUsd: 0.002 }), run('sa-08-revenue-line-chart', true, { ms: 9000, costUsd: 0.004 }), run('aw-08-emoji-only', true, { changedFiles: [], costUsd: 0.0001 })])
    const graded = suite([
      run('crm-01-card-fields', true, { judge: { score: 4, accept: true, reason: '', model: 'h', costUsd: 0 } }),
      run('sa-08-revenue-line-chart', false, { graders: [{ grader: 'browser', pass: false, reason: 'no line' }], judge: { score: 2, accept: false, reason: '', model: 'h', costUsd: 0 } }),
      run('aw-08-emoji-only', true),
    ])
    const r = matrixRow('matrix-x', record, graded)
    expect(r.pass).toEqual({ demo: [1, 1], apps: [0, 1], awkward: [1, 1], all: [2, 3] })
    expect(r.byFamily).toEqual({ simple: [1, 1], chart: [0, 1], vague: [1, 1] })
    expect(r.graders.browser).toEqual([0, 1])
    expect(r.editLatencyMs.median).toBe(6500)
    expect(r.costPerEdit.median).toBeCloseTo(0.003, 10)
    expect(r.judge).toEqual({ accept: 1, judged: 2, mean: 3 })
    expect(r.failures).toEqual([{ taskId: 'sa-08-revenue-line-chart', verdict: 'failed', graders: ['browser'] }])
    expect(markdown([r], 'matrix-x')).toContain('| table or list → chart | 0/1 (0 %) |')
  })

  it('the decision table picks the cheapest model at ≥ 97 % of the reference in each family, on the same tasks', () => {
    const ids = ['crm-01-card-fields', 'crm-03-compile-error-then-fix', 'sa-08-revenue-line-chart']
    const ref = matrixRow('ref', suite(ids.map((id) => run(id, true, { costUsd: 0.02 }))), null)
    const cheap = matrixRow('cheap', suite([run(ids[0]!, true, { costUsd: 0.001, model: 'cheap' }), run(ids[1]!, true, { costUsd: 0.001, model: 'cheap' }), run(ids[2]!, false, { model: 'cheap' })]), null)
    // stopped early: it has no chart run, so it cannot win the chart family even at 100 % of what it ran
    const short = matrixRow('short', suite([run(ids[0]!, true, { costUsd: 0.0001, model: 'short' })], { reason: 'stopped', notRun: ids.slice(1) }), null)
    const pick = cheapestPerFamily([ref, cheap, short], 'ref')
    expect(pick.simple).toMatchObject({ set: 'cheap', pass: [2, 2], refPass: [2, 2] })
    expect(pick.chart).toMatchObject({ set: 'ref' })
    expect(pick.vague).toBeNull()
    expect(short.notRun).toBe(2)
  })

  it('merges several sets into one row (the three Haiku suites of block 6)', () => {
    const m = mergeSuites([suite([run('crm-01-card-fields', true)]), suite([run('sa-01-users-joined-column', false)], { reason: 'cap', notRun: ['sa-02-users-email-second.t1'] })])
    const r = matrixRow('a+b', m, null)
    expect(r.pass.all).toEqual([1, 2])
    expect(r.notRun).toBe(1)
  })
})
