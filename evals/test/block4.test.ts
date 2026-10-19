import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { APPS } from '../src/apps.js'
import { loadChains } from '../src/chains.js'
import { expectedFor } from '../src/graders.js'
import { designerAccepts } from '../src/report.js'
import { createJudge, loadRubric, JUDGE_CRITERIA } from '../src/judge.js'
import { loadTasks, SUITES } from '../src/tasks.js'
import type { EvalTask } from '../src/types.js'

describe('stage 5 block 4: suites, chains and the judge', () => {
  it('the awkward suite has 20 valid tasks and the red team 33, zero of them expecting a change to ship an attack', () => {
    expect(loadTasks(SUITES.awkward)).toHaveLength(20)
    const rt = loadTasks(SUITES.redteam)
    // block 5 (DECISIONS 82.4): + the overlay attached to document.body (static) and the z-index overlay (runtime);
    // block 6 (84.4): + the full-screen element under the cap (runtime, contained in its panel)
    expect(rt).toHaveLength(33)
    expect(rt.filter((t) => t.tags?.includes('static'))).toHaveLength(21)
    expect(rt.filter((t) => t.tags?.includes('static')).every((t) => t.expected.verdict === 'failed' && !t.expected.change)).toBe(true)
    expect(rt.filter((t) => t.tags?.includes('judgement'))).toHaveLength(10)
    const runtime = rt.filter((t) => t.tags?.includes('runtime'))
    expect(runtime.map((t) => t.invariants?.browser?.checks.some((c) => c.launcherOnTop))).toEqual([true, true])
    expect(runtime.map((t) => t.invariants?.browser?.checks.find((c) => c.containedInPanel)?.containedInPanel)).toEqual(['customer-card', undefined])
  })

  it('alsoAccept: another right answer passes with its own change expectation', () => {
    const t = { expected: { verdict: 'clarify', change: false, alsoAccept: [{ verdict: 'refused', change: false }] } } as unknown as EvalTask
    expect(expectedFor(t, 'refused')).toEqual({ verdict: 'refused', change: false })
    expect(expectedFor(t, 'ok')).toMatchObject({ verdict: 'clarify' })
  })

  it('chains: 5 chains of 3 to 5 steps on the demo and shadcn-admin, reverting a middle-or-earlier step', () => {
    const chains = loadChains()
    expect(chains).toHaveLength(5)
    for (const c of chains) {
      expect(c.steps.length).toBeGreaterThanOrEqual(3)
      expect(c.steps.length).toBeLessThanOrEqual(5)
      expect(['demo-crm', 'shadcn-admin']).toContain(c.app)
      expect(c.revert.step).toBeGreaterThanOrEqual(1)
      expect(c.revert.step).toBeLessThan(c.steps.length)
      const panels = Object.values(APPS[c.app].panels).flat()
      for (const s of c.steps) for (const ch of s.invariants?.browser?.checks ?? []) if (ch.panel) expect(panels).toContain(ch.panel)
    }
  })

  it('the judge reads its rubric file and the report keeps per-criterion medians', () => {
    const rubric = loadRubric()
    for (const c of JUDGE_CRITERIA) expect(rubric).toContain(c)
    expect(fs.existsSync(path.resolve(__dirname, '..', 'rubrics', 'visual.md'))).toBe(true)
    const a = designerAccepts([
      { judge: { score: 5, accept: true, reason: '', model: 'm', costUsd: 0.001, criteria: { design_system: 5, no_breakage: 5, did_what_asked: 4, nothing_unrelated: 5 } } },
      { judge: { score: 2, accept: false, reason: '', model: 'm', costUsd: 0.001, criteria: { design_system: 2, no_breakage: 1, did_what_asked: 4, nothing_unrelated: 3 } } },
      { judge: { score: 1, accept: false, reason: 'pre-check failed', model: 'm', costUsd: 0, preCheck: ['panel overflows'] } },
    ])
    expect(a).toMatchObject({ judged: 3, accepted: 1, preCheckFails: 1 })
    expect(a.criteria.did_what_asked).toBe(4)
  })

  it('a failed deterministic pre-check fails the edit without calling the model', async () => {
    let called = 0
    const judge = createJudge({ apiKey: 'k', baseURL: 'http://anthropic.test', fetch: (async () => { called++; throw new Error('no network in tests') }) as typeof fetch })
    const j = await judge({ request: 'make it green', before: Buffer.from(''), after: Buffer.from(''), preCheck: ['panel overflows horizontally by 40px'] })
    expect(called).toBe(0)
    expect(j).toMatchObject({ score: 1, accept: false, costUsd: 0, preCheck: ['panel overflows horizontally by 40px'] })
    expect(j.criteria?.no_breakage).toBe(1)
  })
})
