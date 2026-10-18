import { describe, expect, it } from 'vitest'
import { diffBaseline, pinBaseline } from '../src/baseline.js'
import { percentile, seriesMetrics } from '../src/metrics.js'
import { renderReport } from '../src/report.js'
import type { SuiteResult, TaskRun } from '../src/types.js'

const run = (taskId: string, pass: boolean, over: Partial<TaskRun> = {}): TaskRun => ({
  taskId,
  title: `Task <${taskId}>`,
  agent: 'replay',
  expectedVerdict: 'ok',
  verdict: pass ? 'ok' : 'failed',
  summary: 'Done.',
  changedFiles: [],
  modelCalls: 3,
  firstTry: pass,
  costUsd: 0.05,
  unpricedModels: [],
  tokens: { input: 1000, output: 200, cacheRead: 4000, cacheWrite: 0 },
  ms: 1200,
  graders: [
    { grader: 'verdict', pass, reason: pass ? 'ok' : 'expected ok, got failed <script>' },
    { grader: 'typecheck', pass: true, skipped: true, reason: 'PLEATKIT_TYPECHECK_ROOT is not set' },
  ],
  pass,
  ...over,
})
const suite = (runs: TaskRun[], over: Partial<SuiteResult> = {}): SuiteResult => ({
  kind: 'replay',
  startedAt: '2026-10-18T10:00:00.000Z',
  finishedAt: '2026-10-18T10:01:00.000Z',
  prompt: { version: '2026-10-18.4c1', prefixChars: 14000, prefixTokens: 4000 },
  budget: { capUsd: 2, spentUsd: 0.15 },
  browser: 'ran',
  typecheck: 'skipped',
  runs,
  ...over,
})

describe('baseline: pin and diff', () => {
  const before = suite([run('a', true), run('b', true), run('c', false)], { prompt: { version: '2026-10-18.4b', prefixChars: 13000, prefixTokens: 3700 } })
  const base = pinBaseline(before, new Date('2026-10-18T09:00:00Z'))

  it('pins pass, verdict, failed graders, cost and the prompt version', () => {
    expect(base).toMatchObject({ promptVersion: '2026-10-18.4b', pinnedAt: '2026-10-18T09:00:00.000Z', tasks: { c: { pass: false, failed: ['verdict'], costUsd: 0.05 } } })
    expect(base.passRate).toBeCloseTo(2 / 3)
    expect(() => pinBaseline(suite([], { aborted: { reason: 'out of money', notRun: ['a'] } }))).toThrow(/aborted/)
  })

  it('names regressions, fixes and new tasks', () => {
    const d = diffBaseline(suite([run('a', true), run('b', false), run('c', true), run('d', true)]), base)
    expect(d.status).toEqual({ a: 'pass', b: 'regressed', c: 'fixed', d: 'new' })
    expect(d).toMatchObject({ regressions: ['b'], fixes: ['c'], added: ['d'], missing: [], prompt: { now: '2026-10-18.4c1', baseline: '2026-10-18.4b', prefixTokensBaseline: 3700 } })
    expect(diffBaseline(suite([run('a', true)]), base).missing).toEqual(['b', 'c'])
    expect(diffBaseline(suite([run('a', true)]), null).status).toEqual({ a: 'new' })
  })
})

describe('report: one plain HTML page', () => {
  const s = suite([run('a', true), run('b', false, { recording: { file: 'b.jsonl', promptVersion: '2026-10-18.4b' } })])
  const base = pinBaseline(suite([run('a', true), run('b', true)]))
  const html = renderReport(s, base, { reference: suite([run('a', true)]), null: suite([run('a', false)]), problems: [] }, new Date('2026-10-18T11:00:00Z'))

  it('has per-task rows, pass rates, cost and token totals and the diff against the baseline', () => {
    expect(html).toMatch(/^<!doctype html>/)
    expect(html).toContain('50 %')
    expect(html).toContain('1 of 2 tasks')
    expect(html).toContain('$0.10')
    expect(html).toContain('10,400')
    expect(html).toContain('80 %')
    expect(html).toMatch(/Regressions against the baseline: b/)
    expect(html).toContain('REGRESSED')
    expect(html).toContain('prefix ≈ 4,000 tokens')
    expect(html).toMatch(/Transcripts were recorded with prompt 2026-10-18\.4b/)
    expect(html).toMatch(/Reference solutions: <b>1 of 1<\/b>/)
    expect((html.match(/<tr class="failrow">/g) ?? []).length).toBe(1)
  })

  it('escapes what it shows and loads nothing from elsewhere', () => {
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('Task &lt;a&gt;')
    expect(html).not.toMatch(/(src|href)=["']?https?:/)
    expect(html).not.toMatch(/@import|url\(/)
  })

  it('says when no baseline is pinned', () => {
    expect(renderReport(s, null)).toMatch(/No baseline pinned yet/)
  })
})

describe('trials: baseline, metrics and report (stage 5)', () => {
  const usage = (model: string, calls: number, read: number, write: number, input: number) => ({ model, calls, costUsd: 0, inputTokens: input, outputTokens: 10, cacheReadTokens: read, cacheWriteTokens: write })
  const trials = suite(
    [
      run('a', true, { trial: 1, ms: 4000, costUsd: 0.02, changedFiles: ['x'], model: 'claude-sonnet-5-5', usage: [usage('claude-haiku-5-5', 1, 0, 0, 2000), usage('claude-sonnet-5-5', 2, 9000, 1000, 0)] }),
      run('a', false, { trial: 2, ms: 8000, costUsd: 0.04, changedFiles: ['x'], model: 'claude-sonnet-5-5', usage: [usage('claude-sonnet-5-5', 2, 9000, 1000, 0)] }),
      run('a', true, { trial: 3, ms: 6000, costUsd: 0.03, changedFiles: ['x'], model: 'claude-sonnet-5-5' }),
      run('b', true, { trial: 1, ms: 1000, costUsd: 0.001, modelCalls: 0, firstTry: null }),
    ],
    { set: 'live', model: 'claude-sonnet-5-5' },
  )

  it('pins a task over its trials and diffs by the share of trials that pass', () => {
    const b = pinBaseline(trials)
    expect(b.tasks.a).toMatchObject({ pass: false, passes: 2, trials: 3, verdict: 'ok', failed: ['verdict'], modelCalls: 3 })
    expect(b.tasks.a!.costUsd).toBeCloseTo(0.09)
    expect(b.tasks.b).toMatchObject({ pass: true })
    expect(b.tasks.b!.trials).toBeUndefined()
    expect(diffBaseline(trials, b).status).toEqual({ a: 'fail', b: 'pass' })
    const worse = suite(trials.runs.map((r) => (r.taskId === 'a' && r.trial === 3 ? { ...r, pass: false } : r)))
    expect(diffBaseline(worse, b).regressions).toEqual(['a'])
    const better = suite(trials.runs.map((r) => ({ ...r, pass: true })))
    expect(diffBaseline(better, b).fixes).toEqual(['a'])
  })

  it('computes the series numbers: per task, latency, cost per edit, cache hit rate', () => {
    const m = seriesMetrics(trials)
    expect(m.tasks.map((t) => [t.taskId, t.passes, t.trials, t.medianMs])).toEqual([
      ['a', 2, 3, 6000],
      ['b', 1, 1, 1000],
    ])
    expect(m.tasksAllPass).toBe(1)
    expect(m.latencyMs).toEqual({ median: 5000, p90: 8000, max: 8000 })
    expect(m.costPerEdit.runs).toBe(3)
    expect(m.costPerEdit.median).toBeCloseTo(0.03)
    expect(m.costPerEdit.max).toBeCloseTo(0.04)
    expect(m.modelCalls).toEqual({ median: 3, total: 9, runs: 3 })
    // cacheHitRate() over every row: 18000 read of 2000 + 20000; main model rows only: 18000 of 20000
    expect(m.cacheHitRate).toBeCloseTo(18000 / 22000)
    expect(m.mainCacheHitRate).toBeCloseTo(0.9)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9)
    expect(percentile([], 90)).toBe(0)
  })

  it('the report shows the tasks across trials and labels each run with its trial', () => {
    const html = renderReport(trials, pinBaseline(trials))
    expect(html).toContain('Tasks across trials')
    expect(html).toContain('2 / 3')
    expect(html).toContain('a #2')
    expect(html).toContain('3 of 4 runs; 1 of 2 tasks pass every trial')
    expect(html).toContain('median 5.0 s')
    expect(html).toContain('main model only 90 %')
    expect(html).toContain('of the set live')
  })
})
