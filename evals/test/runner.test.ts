import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ReplayProvider, ScriptedProvider, type TranscriptLine } from '@pleatkit/agent'
import { budgetFromEnv, BudgetExceededError, EvalBudget, gradeBudget } from '../src/budget.js'
import { oracleProvider, recordingFile, replayProvider, trialsIn } from '../src/providers.js'
import { graderRates, passRate, runSuite, taskPasses, type BrowserCase } from '../src/runner.js'
import { sanityProblems } from '../src/sanity.js'
import type { EvalTask } from '../src/types.js'
import { CARD, changeTask, MANIFEST, noChangeTask, PHONE_CARD } from './helpers.js'

const tasks = [changeTask(), noChangeTask()]

describe('runner: reference and null agents (the sanity check)', () => {
  it('the reference passes every grader; the null agent fails the change task and passes the no-change one', async () => {
    const seen: BrowserCase[][] = []
    const browser = async (cases: BrowserCase[]) => {
      seen.push(cases)
      return Object.fromEntries(cases.map((c) => [c.taskId, { grader: 'browser' as const, pass: Object.keys(c.files).length > 0, reason: 'stub' }]))
    }
    const ref = await runSuite({ kind: 'sanity-reference', agent: 'reference', tasks, manifest: MANIFEST, providerFor: (t) => oracleProvider(t, { write: true }), browser })
    const nul = await runSuite({ kind: 'sanity-null', agent: 'null', tasks, manifest: MANIFEST, providerFor: (t) => oracleProvider(t, { write: false }), browser })
    expect(ref.runs.map((r) => [r.taskId, r.pass])).toEqual([['t-phone', true], ['t-backend', true]])
    expect(nul.runs.map((r) => [r.taskId, r.pass])).toEqual([['t-phone', false], ['t-backend', true]])
    // only tasks with browser invariants go to the browser, with the files the run produced
    expect(seen[0]!.map((c) => c.taskId)).toEqual(['t-phone'])
    expect(seen[0]![0]!.files[CARD]).toBe(PHONE_CARD)
    expect(ref.runs[1]!.graders.find((g) => g.grader === 'browser')).toMatchObject({ skipped: true })
    expect(sanityProblems(tasks, ref, nul)).toEqual([])
    // a null agent that passes a change task is a grader bug
    expect(sanityProblems(tasks, ref, ref)).toEqual([expect.stringMatching(/null agent passes t-phone/)])
    expect(sanityProblems(tasks, nul, nul)[0]).toMatch(/reference of t-phone fails: change/)
    expect(passRate(ref)).toBe(1)
    expect(graderRates(nul).change).toEqual({ pass: 1, total: 2 })
    expect(ref.prompt.prefixTokens).toBeGreaterThan(1000)
  })

  it('without a browser grader the browser invariants are skipped, not failed', async () => {
    const s = await runSuite({ kind: 'replay', agent: 'reference', tasks: [changeTask()], manifest: MANIFEST, providerFor: (t) => oracleProvider(t, { write: true }) })
    expect(s.browser).toBe('skipped')
    expect(s.runs[0]!.graders.find((g) => g.grader === 'browser')).toMatchObject({ pass: true, skipped: true, reason: expect.stringMatching(/switched off/) })
  })

  it('records one transcript per task, and its replay gives the same result', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-evals-rec-'))
    const scripted = new ScriptedProvider([
      { name: 'phone', match: ['.'], dir: '.', patterns: [/./], classify: { label: 'ui' }, turns: [{ calls: [{ tool: 'write_file', input: { path: CARD, content: PHONE_CARD } }] }, { calls: [{ tool: 'finish', input: { verdict: 'ok', summary: 'The card shows the phone.' } }] }] },
    ])
    const rec = await runSuite({ kind: 'record', agent: 'scripted', tasks: [changeTask()], manifest: MANIFEST, providerFor: () => scripted, recordDir: dir })
    expect(fs.existsSync(recordingFile('t-phone', dir))).toBe(true)
    expect(rec.runs[0]!.recording).toMatchObject({ file: 't-phone.jsonl', promptVersion: expect.any(String) })
    const replay = await runSuite({ kind: 'replay', agent: 'replay', tasks: [changeTask()], manifest: MANIFEST, providerFor: () => new ReplayProvider(recordingFile('t-phone', dir)), recordingOf: () => recordingFile('t-phone', dir) })
    expect(replay.runs[0]).toMatchObject({ verdict: 'ok', pass: true, changedFiles: [CARD], modelCalls: 2, firstTry: true })
    expect(replay.runs[0]!.recording?.promptVersion).toBe(rec.runs[0]!.recording?.promptVersion)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

/** A transcript whose every turn costs about $0.20 on Sonnet 5.5 (100k uncached input tokens at $2/M). */
function pricedTranscript(turns: number): TranscriptLine[] {
  const usage = { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  return [
    { kind: 'meta', runId: 'r', promptVersion: 'test', provider: 'anthropic', model: 'claude-sonnet-5-5', at: '2026-10-18T00:00:00Z' },
    ...Array.from({ length: turns }, (_, i): TranscriptLine => ({
      kind: 'turn',
      index: i,
      results: [],
      ms: 1,
      maxOutputTokens: 8000,
      turn: { text: '', toolCalls: [{ id: `r${i}`, name: 'read_file', input: { path: CARD } }], stop: 'tool_use', usage, model: 'claude-sonnet-5-5' },
    })),
  ]
}
const pointed = (id: string): EvalTask => changeTask({ id, target: 'customer-card', invariants: {} })

describe('budget: PLEATKIT_EVAL_BUDGET_USD and the per-task cap', () => {
  it('parses the global cap', () => {
    expect(budgetFromEnv({})).toBeNull()
    expect(budgetFromEnv({ PLEATKIT_EVAL_BUDGET_USD: '2' })).toBe(2)
    expect(() => budgetFromEnv({ PLEATKIT_EVAL_BUDGET_USD: 'lots' })).toThrow(/positive number/)
  })

  it('each task gets the smaller of its cap and what is left; a spent budget refuses the next task', () => {
    const b = new EvalBudget(1)
    expect(b.limitFor(0.5)).toBe(0.5)
    b.charge(0.8)
    expect(b.limitFor(0.5)).toBeCloseTo(0.2)
    b.charge(0.3)
    expect(() => b.admit('t2', ['t2', 't3'])).toThrow(BudgetExceededError)
    expect(() => b.admit('t2', ['t2', 't3'])).toThrow(/\$1\.10 spent of PLEATKIT_EVAL_BUDGET_USD=\$1\.00.*2 task\(s\) not run: t2, t3/)
    expect(() => new EvalBudget(null).admit('t')).not.toThrow()
  })

  it('the budget grader reports a cost stop and an overshoot', () => {
    expect(gradeBudget(0.1, 0.5, undefined, 0.5)).toMatchObject({ pass: true, reason: '$0.10 of $0.50' })
    expect(gradeBudget(0.6, 0.5, 'cost', 0.5).reason).toMatch(/stopped by the task cap of \$0\.50/)
    expect(gradeBudget(0.4, 0.5, 'cost', 0.3).reason).toMatch(/what was left of PLEATKIT_EVAL_BUDGET_USD/)
    expect(gradeBudget(0.7, 0.5, undefined, 0.5).pass).toBe(false)
  })

  it('a priced run is stopped by its task cap; the suite stops once the global cap is spent', async () => {
    const perTask = await runSuite({ kind: 'replay', agent: 'replay', tasks: [{ ...pointed('a'), budgetUsd: 0.25 }], manifest: MANIFEST, providerFor: () => new ReplayProvider(pricedTranscript(5)) })
    const a = perTask.runs[0]!
    expect(a).toMatchObject({ stopReason: 'cost', modelCalls: 2, unpricedModels: [] })
    expect(a.costUsd).toBeCloseTo(0.4)
    expect(a.tokens.input).toBe(200_000)
    expect(a.graders.find((g) => g.grader === 'budget')).toMatchObject({ pass: false, reason: expect.stringMatching(/task cap of \$0\.25/) })

    const global = await runSuite({ kind: 'replay', agent: 'replay', tasks: [pointed('a'), pointed('b'), pointed('c')], manifest: MANIFEST, providerFor: () => new ReplayProvider(pricedTranscript(5)), budget: new EvalBudget(0.3) })
    expect(global.runs.map((r) => r.taskId)).toEqual(['a'])
    expect(global.budget.spentUsd).toBeCloseTo(0.4)
    expect(global.aborted?.notRun).toEqual(['b', 'c'])
    expect(global.aborted?.reason).toMatch(/Eval budget exhausted: \$0\.40 spent of PLEATKIT_EVAL_BUDGET_USD=\$0\.30\. Stopped before task b/)
  })
})

describe('trials and named sets (stage 5)', () => {
  it('records each trial as <task>.t<n>.jsonl and replays every trial of a set', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-evals-set-'))
    const scripted = () =>
      new ScriptedProvider([
        { name: 'phone', match: ['.'], dir: '.', patterns: [/./], classify: { label: 'ui' }, turns: [{ calls: [{ tool: 'write_file', input: { path: CARD, content: PHONE_CARD } }] }, { calls: [{ tool: 'finish', input: { verdict: 'ok', summary: 'The card shows the phone.' } }] }] },
      ])
    const seen: string[] = []
    const browser = async (cases: BrowserCase[]) => {
      seen.push(...cases.map((c) => c.taskId))
      return Object.fromEntries(cases.map((c) => [c.taskId, { grader: 'browser' as const, pass: true, reason: 'stub' }]))
    }
    const rec = await runSuite({ kind: 'record', agent: 'scripted', tasks: [changeTask()], manifest: MANIFEST, providerFor: () => scripted(), trials: 3, set: 'x', recordDir: dir, browser })
    expect(rec.runs.map((r) => [r.trial, r.recording?.file, r.pass])).toEqual([
      [1, 't-phone.t1.jsonl', true],
      [2, 't-phone.t2.jsonl', true],
      [3, 't-phone.t3.jsonl', true],
    ])
    expect(seen).toEqual(['t-phone.t1', 't-phone.t2', 't-phone.t3'])
    expect(rec.set).toBe('x')
    expect(trialsIn('t-phone', dir)).toEqual([1, 2, 3])
    expect(trialsIn('t-phone', path.join(dir, 'none'))).toEqual([])
    const replay = await runSuite({
      kind: 'replay',
      agent: 'replay',
      tasks: [changeTask()],
      manifest: MANIFEST,
      set: 'x',
      trials: (t) => trialsIn(t.id, dir).length,
      providerFor: (t, n) => replayProvider(t, dir, n),
      recordingOf: (t, n) => recordingFile(t.id, dir, n),
    })
    expect(replay.runs.map((r) => [r.taskId, r.trial, r.verdict, r.recording?.file])).toEqual([
      ['t-phone', 1, 'ok', 't-phone.t1.jsonl'],
      ['t-phone', 2, 'ok', 't-phone.t2.jsonl'],
      ['t-phone', 3, 'ok', 't-phone.t3.jsonl'],
    ])
    expect(taskPasses(replay)).toEqual({ 't-phone': { passes: 3, trials: 3 } })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('the classifier can be switched off: the main loop answers a needs-backend request itself', async () => {
    let classified = 0
    const provider = new ScriptedProvider([{ name: 'nb', match: ['.'], dir: '.', patterns: [/./], classify: { label: 'needs-backend', reason: 'server' }, turns: [{ calls: [{ tool: 'finish', input: { verdict: 'needs-backend', summary: 'This needs the server.', backend_note: 'add it' } }] }] }])
    const counting = { ...provider, name: provider.name, model: provider.model, classify: (...a: Parameters<typeof provider.classify>) => (classified++, provider.classify(...a)), start: provider.start.bind(provider) }
    const on = await runSuite({ kind: 'replay', agent: 'scripted', tasks: [noChangeTask()], manifest: MANIFEST, providerFor: () => counting })
    const off = await runSuite({ kind: 'replay', agent: 'scripted', tasks: [noChangeTask()], manifest: MANIFEST, providerFor: () => counting, classify: false })
    expect(classified).toBe(1)
    expect(on.runs[0]).toMatchObject({ verdict: 'needs-backend', modelCalls: 0 })
    expect(off.runs[0]).toMatchObject({ verdict: 'needs-backend', modelCalls: 1 })
    expect(off.classifier).toBe(false)
  })
})
