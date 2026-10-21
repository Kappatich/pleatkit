import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Alert, AlertSink } from '@pleatkit/agent'
import { PRIVATE_EVALS_DIR } from '../src/apps.js'
import { BASELINE_FILE } from '../src/tasks.js'
import type { Baseline, SuiteResult, TaskRun } from '../src/types.js'
import {
  alertText,
  decide,
  discoverSets,
  judgeLive,
  judgeSet,
  runWeekly,
  sendDriftAlert,
  skippedLive,
  weeklyBudget,
  type SetSpec,
  type WeeklyDeps,
  type WeeklySummary,
} from '../src/weekly.js'

const run = (taskId: string, pass: boolean, trial?: number): TaskRun =>
  ({ taskId, pass, verdict: 'ok', graders: [], modelCalls: 1, costUsd: 0, ...(trial ? { trial } : {}) }) as unknown as TaskRun

const suite = (runs: TaskRun[], extra: Partial<SuiteResult> = {}): SuiteResult =>
  ({ kind: 'replay', startedAt: '', finishedAt: '', prompt: { version: '5i', prefixTokens: 1 }, budget: { capUsd: null, spentUsd: 0 }, browser: 'ran', typecheck: 'skipped', runs, ...extra }) as SuiteResult

const baseline = (tasks: Record<string, { passes: number; trials: number } | boolean>): Baseline => ({
  pinnedAt: '2026-10-18T00:00:00.000Z',
  promptVersion: '5a',
  prompt: { version: '5a', prefixTokens: 1 } as Baseline['prompt'],
  passRate: 1,
  tasks: Object.fromEntries(
    Object.entries(tasks).map(([id, t]) => [
      id,
      typeof t === 'boolean' ? { pass: t, verdict: 'ok', failed: [], costUsd: 0, modelCalls: 1 } : { pass: t.passes === t.trials, verdict: 'ok', failed: [], costUsd: 0, modelCalls: 1, passes: t.passes, trials: t.trials },
    ]),
  ) as Baseline['tasks'],
})

const ids = Array.from({ length: 14 }, (_, i) => `crm-${String(i + 1).padStart(2, '0')}`)
const liveBase = baseline(Object.fromEntries(ids.map((id) => [id, { passes: 3, trials: 3 }])))
const liveRun = (failing: number, extra: Partial<SuiteResult> = {}) =>
  suite(ids.map((id, i) => run(id, i >= failing, 1)), { kind: 'record', set: 'weekly-2026-10-19', budget: { capUsd: 0.3, spentUsd: 0.142 }, model: 'claude-sonnet-5-5', ...extra })

const spec = (name: string, withBaseline = true): SetSpec => ({ name, set: name, baselineFile: withBaseline ? `/x/baseline.${name}.json` : null })

describe('eval:weekly: replayed sets (brainstorm 17 §20)', () => {
  it('a set regresses when a task passes in a smaller share of its trials than in the baseline', () => {
    const base = baseline({ 'aw-01': { passes: 2, trials: 2 }, 'aw-02': { passes: 1, trials: 2 }, 'aw-03': false })
    const same = judgeSet(spec('awkward'), suite([run('aw-01', true, 1), run('aw-01', true, 2), run('aw-02', true, 1), run('aw-02', false, 2), run('aw-03', false, 1), run('aw-03', false, 2)]), base)
    expect(same).toMatchObject({ status: 'ok', regressions: [], tasks: 3, passingTasks: 1, runs: 6, passingRuns: 3 })
    const worse = judgeSet(spec('awkward'), suite([run('aw-01', true, 1), run('aw-01', false, 2), run('aw-02', false, 1), run('aw-02', false, 2), run('aw-03', true, 1), run('aw-03', true, 2)]), base)
    expect(worse.status).toBe('regressed')
    expect(worse.regressions).toEqual(['aw-01', 'aw-02'])
    expect(worse.fixes).toEqual(['aw-03'])
    // a task added to the set after the pin: named when it fails, never a regression
    const added = judgeSet(spec('awkward'), suite([run('aw-01', true, 1), run('aw-01', true, 2), run('aw-02', true, 1), run('aw-02', false, 2), run('aw-03', false, 1), run('aw-99', false, 1), run('aw-98', true, 1)]), base)
    expect(added).toMatchObject({ status: 'ok', regressions: [], newFailing: ['aw-99'] })
  })

  it('a set without a baseline (the blind sets) is counted and never regresses; a set with no results is an error', () => {
    const o = judgeSet(spec('blind-ab', false), suite([run('ab-01', false, 1), run('ab-01', true, 2)]), null)
    expect(o).toMatchObject({ status: 'no-baseline', tasks: 1, passingTasks: 0, regressions: [], baseline: null })
    const e = judgeSet(spec('blind-me', false), null, null, 'evals/apps/mesa/dist/pleatkit.manifest.json is missing')
    expect(e).toMatchObject({ status: 'error', error: 'evals/apps/mesa/dist/pleatkit.manifest.json is missing' })
    expect(decide([o], skippedLive('--no-live')).drift).toBe(false)
    expect(decide([o, e], skippedLive('--no-live'))).toMatchObject({ drift: true, broken: [e] })
  })

  it('discoverSets maps baseline files to sets and adds the blind sets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-'))
    for (const f of ['baseline.json', 'baseline.scripted.json', 'baseline.apps.json', 'baseline.redteam.json', 'baseline.notes.txt']) fs.writeFileSync(path.join(dir, f), '{}')
    const sets = discoverSets(dir, ['blind-ab', 'apps'])
    expect(sets.map((s) => [s.name, s.set ?? null, s.baselineFile ? path.basename(s.baselineFile) : null])).toEqual([
      ['scripted', null, 'baseline.scripted.json'],
      ['live', 'live', 'baseline.json'],
      ['apps', 'apps', 'baseline.apps.json'],
      ['blind-ab', 'blind-ab', null],
      ['redteam', 'redteam', 'baseline.redteam.json'],
    ])
    fs.rmSync(dir, { recursive: true, force: true })
    // the repository's own baselines: the scripted demo set; the others come from the private clone
    expect(discoverSets().map((s) => s.name)).toEqual(
      expect.arrayContaining(PRIVATE_EVALS_DIR ? ['scripted', 'live', 'apps', 'awkward', 'redteam', 'blind-ab', 'blind-me'] : ['scripted']),
    )
    // a name found in the first folder is not taken again from the second
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-a-'))
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-b-'))
    for (const f of ['baseline.scripted.json']) fs.writeFileSync(path.join(a, f), '{}')
    for (const f of ['baseline.scripted.json', 'baseline.awkward.json']) fs.writeFileSync(path.join(b, f), '{}')
    expect(discoverSets([a, b], []).map((s) => [s.name, path.dirname(s.baselineFile!)])).toEqual([
      ['scripted', a],
      ['awkward', b],
    ])
    fs.rmSync(a, { recursive: true, force: true })
    fs.rmSync(b, { recursive: true, force: true })
  })
})

describe('eval:weekly: the live run against baseline.json', () => {
  it('one task below the baseline is noise, two is drift', () => {
    const one = judgeLive(liveRun(1), liveBase)
    expect(one).toMatchObject({ status: 'ok', passes: 13, tasks: 14, expected: 14, tasksBelow: 1, failed: ['crm-01'], costUsd: 0.142, capUsd: 0.3 })
    const two = judgeLive(liveRun(2), liveBase)
    expect(two).toMatchObject({ status: 'below', passes: 12, tasksBelow: 2, failed: ['crm-01', 'crm-02'] })
    expect(decide([], one).drift).toBe(false)
    expect(decide([], two)).toMatchObject({ drift: true, liveBelow: true })
  })

  it('the expectation sums the baseline pass shares; a task the baseline never passed does not count as below', () => {
    const base = baseline({ ...Object.fromEntries(ids.map((id) => [id, { passes: 3, trials: 3 }])), 'crm-01': { passes: 0, trials: 3 }, 'crm-02': { passes: 2, trials: 3 } })
    const l = judgeLive(liveRun(3), base) // crm-01..03 fail
    expect(l.expected).toBe(12.67)
    expect(l.tasksBelow).toBe(1.67)
    expect(l.status).toBe('ok')
    expect(l.failed).toEqual(['crm-02', 'crm-03'])
  })

  it('without baseline.json the live run is reported, not compared; tasks not run (budget) are left out', () => {
    expect(judgeLive(liveRun(5), null)).toMatchObject({ status: 'no-baseline', expected: null, tasksBelow: 0, passes: 9 })
    const cut = suite(ids.slice(0, 10).map((id) => run(id, true, 1)), { kind: 'record', budget: { capUsd: 0.3, spentUsd: 0.3 }, aborted: { reason: 'Eval budget exhausted', notRun: ids.slice(10) } })
    expect(judgeLive(cut, liveBase)).toMatchObject({ status: 'ok', tasks: 10, passes: 10, expected: 10, tasksBelow: 0, aborted: 'Eval budget exhausted' })
  })

  it('the budget: $0.30 by default, a cap above $1 is refused without --force, a bad value is refused', () => {
    expect(weeklyBudget({}, false)).toEqual({ capUsd: 0.3 })
    expect(weeklyBudget({ PLEATKIT_EVAL_BUDGET_USD: '0.5' }, false)).toEqual({ capUsd: 0.5 })
    expect(weeklyBudget({ PLEATKIT_EVAL_BUDGET_USD: '1' }, false)).toEqual({ capUsd: 1 })
    expect(weeklyBudget({ PLEATKIT_EVAL_BUDGET_USD: '6' }, false)).toEqual({ error: expect.stringContaining('--force') })
    expect(weeklyBudget({ PLEATKIT_EVAL_BUDGET_USD: '6' }, true)).toEqual({ capUsd: 6 })
    expect(weeklyBudget({ PLEATKIT_EVAL_BUDGET_USD: 'lots' }, false)).toEqual({ error: expect.stringContaining('positive number') })
  })
})

const summaryBase = (sets: WeeklySummary['sets'], live: WeeklySummary['live']) => ({
  date: '2026-10-19',
  sets,
  live,
  costUsd: live.costUsd,
  report: { json: 'evals/results/weekly-2026-10-19.json', html: 'evals/results/weekly-2026-10-19.html' },
  runUrl: 'https://github.com/o/r/actions/runs/7',
})

describe('eval:weekly: the alert', () => {
  const regressed = judgeSet(spec('awkward'), suite([run('aw-03', false, 1)]), baseline({ 'aw-03': true }))
  const ok = judgeSet(spec('redteam'), suite([run('rt-01', true)]), baseline({ 'rt-01': true }))

  it('names the sets, the tasks below, the cost and the report', () => {
    const { title, text } = alertText(summaryBase([regressed, ok], judgeLive(liveRun(2), liveBase)))
    expect(title).toBe('Weekly eval drift 2026-10-19: 1 set regressed; live run 2 tasks below the baseline')
    expect(text.split('\n')).toEqual([
      'Regressed: awkward: aw-03 (0 of 1 tasks pass)',
      'Live run weekly-2026-10-19: 12 of 14 tasks pass, the baseline expects 14: 2 below (failed: crm-01, crm-02)',
      'Cost: $0.14 (cap $0.30)',
      'Report: evals/results/weekly-2026-10-19.json, evals/results/weekly-2026-10-19.html',
      'Run: https://github.com/o/r/actions/runs/7',
    ])
    expect(alertText(summaryBase([regressed], skippedLive('--no-live'))).text).toContain('Live run: skipped (--no-live)\nCost: $0.00\n')
  })

  it('goes through the sinks once; --no-alert prints it; no channel is noted', async () => {
    const got: Alert[] = []
    const sink: AlertSink = { send: async (a) => void got.push(a) }
    const lines: string[] = []
    const s = summaryBase([regressed, ok], judgeLive(liveRun(2), liveBase))
    expect(await sendDriftAlert(s, [sink], (l) => lines.push(l))).toEqual({ sent: 1, channels: 1 })
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ kind: 'eval-drift', severity: 'warning', appId: 'pleatkit-evals', details: { regressed: { awkward: ['aw-03'] }, liveTasksBelow: 2, costUsd: 0.142, report: 'evals/results/weekly-2026-10-19.json' } })
    expect(String(got[0]!.details.text)).toContain('Regressed: awkward')
    expect(await sendDriftAlert(s, null, (l) => lines.push(l))).toEqual({ sent: 0, channels: 0, note: '--no-alert' })
    expect(lines.at(-1)).toContain('alert (not sent, --no-alert)')
    expect(await sendDriftAlert(s, [], (l) => lines.push(l))).toMatchObject({ sent: 0, note: 'no channel configured' })
  })
})

describe('eval:weekly: the run (fake replays, record and sink)', () => {
  function fakeDeps(o: { env?: Record<string, string>; regress?: boolean; liveFailing?: number; sets?: SetSpec[] } = {}) {
    const calls: string[] = []
    const posts: { url: string; body: { text: string } }[] = []
    const fetchFn = (async (url: string, init?: RequestInit) => (posts.push({ url, body: JSON.parse(String(init?.body)) }), new Response('{}'))) as typeof fetch
    let summary: WeeklySummary | null = null
    const lines: string[] = []
    const baselines: Record<string, Baseline> = { '/x/baseline.awkward.json': baseline({ 'aw-01': true }), [BASELINE_FILE]: liveBase }
    const deps: WeeklyDeps = {
      env: o.env ?? {},
      sets: o.sets ?? [spec('awkward'), spec('blind-ab', false)],
      async replay(s) {
        calls.push(`replay ${s.name}`)
        return { result: suite([run(s.name === 'awkward' ? 'aw-01' : 'ab-01', !o.regress)]), code: 0 }
      },
      async record(set, cap) {
        calls.push(`record ${set} ${cap}`)
        return { result: liveRun(o.liveFailing ?? 0), code: 0 }
      },
      async report(set, out) {
        calls.push(`report ${set}`)
        return out
      },
      loadBaseline: (f) => baselines[f] ?? null,
      writeSummary: (_f, s) => void (summary = s),
      log: (l) => lines.push(l),
      now: () => new Date('2026-10-19T06:00:00.000Z'),
    }
    return { deps, calls, posts, lines, summary: () => summary, fetchFn }
  }

  it('--no-live: replays only, $0, exit 0, nothing sent', async () => {
    const f = fakeDeps({ env: { PLEATKIT_API_KEY: 'k' } })
    const s = (await runWeekly(['--no-live'], f.deps)) as WeeklySummary
    expect(f.calls).toEqual(['replay awkward', 'replay blind-ab'])
    expect(s).toMatchObject({ exitCode: 0, drift: false, costUsd: 0, alert: null, live: { status: 'skipped', reason: '--no-live' } })
    expect(f.summary()!.report.json).toBe('evals/results/weekly-2026-10-19.json')
  })

  it('no key: the live part is skipped, not an error', async () => {
    const f = fakeDeps()
    expect(await runWeekly([], f.deps)).toMatchObject({ exitCode: 0, live: { status: 'skipped', reason: 'no PLEATKIT_API_KEY' } })
    expect(f.calls).not.toContain(expect.stringMatching(/^record/))
  })

  it('a regression and a live run 2 below: one alert through the webhook, exit 1', async () => {
    const f = fakeDeps({ env: { PLEATKIT_API_KEY: 'k', PLEATKIT_ALERT_WEBHOOK: 'http://hook.test' }, regress: true, liveFailing: 2 })
    const realFetch = globalThis.fetch
    globalThis.fetch = f.fetchFn
    try {
      const s = (await runWeekly(['--date', '2026-10-19'], f.deps)) as WeeklySummary
      expect(f.calls).toEqual(['replay awkward', 'replay blind-ab', 'record weekly-2026-10-19 0.3', 'report weekly-2026-10-19'])
      expect(s).toMatchObject({ exitCode: 1, drift: true, alert: { sent: 1, channels: 1 }, live: { status: 'below', tasksBelow: 2 }, report: { html: 'evals/results/weekly-2026-10-19.html' } })
      expect(f.posts).toHaveLength(1)
      expect(f.posts[0]!.url).toBe('http://hook.test')
      expect(f.posts[0]!.body.text).toContain('[pleatkit warning] Weekly eval drift 2026-10-19: 1 set regressed; live run 2 tasks below the baseline')
      expect(f.posts[0]!.body.text).toContain('Cost: $0.14 (cap $0.30)')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('a live run 1 below is not drift', async () => {
    const f = fakeDeps({ env: { PLEATKIT_API_KEY: 'k', PLEATKIT_EVAL_BUDGET_USD: '0.5' }, liveFailing: 1 })
    expect(await runWeekly([], f.deps)).toMatchObject({ exitCode: 0, drift: false, live: { status: 'ok', tasksBelow: 1 } })
    expect(f.calls).toContain('record weekly-2026-10-19 0.5')
  })

  it('configuration errors exit 2 before anything runs: a cap above $1, an e-mail URL without a recipient, an unknown set', async () => {
    for (const [env, argv, msg] of [
      [{ PLEATKIT_API_KEY: 'k', PLEATKIT_EVAL_BUDGET_USD: '5' }, [], '--force'],
      [{ PLEATKIT_ALERT_EMAIL_URL: 'http://mail.test' }, ['--no-live'], 'PLEATKIT_ALERT_EMAIL_TO'],
      [{}, ['--sets', 'nope'], 'nope'],
      [{}, ['--date', 'monday'], 'YYYY-MM-DD'],
    ] as const) {
      const f = fakeDeps({ env: { ...env } })
      const r = await runWeekly([...argv], f.deps)
      expect(r).toMatchObject({ exitCode: 2, error: expect.stringContaining(msg) })
      expect(f.calls).toEqual([])
    }
    // --force lifts the cap refusal
    const f = fakeDeps({ env: { PLEATKIT_API_KEY: 'k', PLEATKIT_EVAL_BUDGET_USD: '5' } })
    expect(await runWeekly(['--force'], f.deps)).toMatchObject({ exitCode: 0 })
    expect(f.calls).toContain('record weekly-2026-10-19 5')
  })

  it('a live record that wrote no results exits 2 (key, model, network), without an alert', async () => {
    const f = fakeDeps({ env: { PLEATKIT_API_KEY: 'k' } })
    f.deps.record = async () => ({ error: 'eval:record --live spends money: set PLEATKIT_API_KEY', code: 2 })
    expect(await runWeekly([], f.deps)).toMatchObject({ exitCode: 2, alert: null, live: { status: 'error', capUsd: 0.3 } })
  })
})

describe('block 6: replays run without the live cap', () => {
  it('drops PLEATKIT_EVAL_BUDGET_USD from the replay environment only', async () => {
    const { replayEnv } = await import('../src/weekly.js')
    expect(replayEnv({ PLEATKIT_EVAL_BUDGET_USD: '0.3', PATH: 'x' })).toEqual({ PATH: 'x' })
  })
})
