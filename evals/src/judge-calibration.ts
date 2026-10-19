import fs from 'node:fs'
import path from 'node:path'
import type { EvalBudget } from './budget.js'
import { APPS, routeOf } from './apps.js'
import { designSystemOf, JUDGE_MODEL, JUDGE_THRESHOLD, readShot, type Judge } from './judge.js'
import type { BrowserCase, BrowserGrader } from './runner.js'
import { shotPanel } from './runner.js'
import { EVALS_DIR, loadManifests, loadSuites, readRefs, REPO_ROOT, SUITES, type Suite } from './tasks.js'

/**
 * The judge's calibration (DECISIONS 75 Р3): reference solutions a designer would accept must score at least 4, and
 * deliberately ugly edits written for the purpose at most 2. `evals/judge/calibration.json` lists the cases (a task
 * and the files to commit); `pnpm eval:judge -- --calibrate` renders each in the browser grader, judges it and writes
 * `evals/judge/calibration-result.json`.
 */
export const CALIBRATION_FILE = path.join(EVALS_DIR, 'judge', 'calibration.json')
export const CALIBRATION_RESULT = path.join(EVALS_DIR, 'judge', 'calibration-result.json')

export interface CalibrationCase {
  id: string
  /** The task whose request, app and route the case uses. */
  task: string
  /** `reference`: the task's reference solution (should score ≥ 4); `ugly`: these files (should score ≤ 2). */
  kind: 'reference' | 'ugly'
  /** For `ugly`: dynamic path → repo path of the deliberately ugly edit. */
  files?: Record<string, string>
  /** What makes it ugly (shown in the result). */
  why?: string
}

export interface CalibrationRow {
  id: string
  task: string
  kind: CalibrationCase['kind']
  score: number
  reason: string
  ok: boolean
  costUsd: number
  why?: string
}

export async function calibrateJudge(o: { judge: Judge; browser: BrowserGrader; budget: EvalBudget; log: (l: string) => void; only?: string[] }): Promise<{ ok: boolean; summary: string; costUsd: number; rows: CalibrationRow[] }> {
  const only = o.only?.length ? o.only : null
  const cases = (JSON.parse(fs.readFileSync(CALIBRATION_FILE, 'utf8')) as { cases: CalibrationCase[] }).cases.filter((c) => !only || only.some((x) => c.id.startsWith(x)))
  const tasks = loadSuites(Object.keys(SUITES) as Suite[]).filter((t) => cases.some((c) => c.task === t.id))
  const manifests = loadManifests(tasks)
  const browserCases: BrowserCase[] = cases.map((c) => {
    const t = tasks.find((x) => x.id === c.task)
    if (!t) throw new Error(`calibration case ${c.id}: no task ${c.task}`)
    const refs = c.kind === 'reference' ? t.reference?.files : c.files
    if (!refs) throw new Error(`calibration case ${c.id}: no files (a reference case needs a task with a reference)`)
    const files = readRefs(refs)
    const inv = t.invariants?.browser ?? { checks: [] }
    const route = inv.path ?? routeOf(t.app, t.target ?? inv.checks.find((x) => x.panel)?.panel)
    const app = t.app !== 'demo-crm' ? { app: t.app, path: route, panels: APPS[t.app].panels[route] ?? [] } : {}
    return { taskId: `cal-${c.id}`, ...app, files, deleted: [], invariants: inv, shot: { panel: shotPanel(t, Object.keys(files)) } }
  })
  o.log(`judge calibration: ${cases.length} cases in the browser`)
  const shots = await o.browser(browserCases)
  const rows: CalibrationRow[] = []
  let cost = 0
  for (const c of cases) {
    const t = tasks.find((x) => x.id === c.task)!
    const s = shots[`cal-${c.id}`]?.shots
    const before = s ? readShot(s.before) : null
    const after = s ? readShot(s.after) : null
    if (!before || !after) {
      rows.push({ id: c.id, task: c.task, kind: c.kind, score: 0, reason: `no screenshots: ${shots[`cal-${c.id}`]?.reason ?? 'no browser result'}`, ok: false, costUsd: 0 })
      continue
    }
    o.budget.admit(c.id)
    const j = await o.judge({ request: t.request, designSystem: designSystemOf(manifests[t.app]), before, after, ...(shots[`cal-${c.id}`]?.visual?.length ? { preCheck: shots[`cal-${c.id}`]!.visual } : {}) })
    o.budget.charge(j.costUsd)
    cost += j.costUsd
    const ok = c.kind === 'reference' ? j.score >= JUDGE_THRESHOLD : j.score > 0 && j.score <= 2
    rows.push({ id: c.id, task: c.task, kind: c.kind, score: j.score, reason: j.reason, ok, costUsd: j.costUsd, ...(c.why ? { why: c.why } : {}) })
    o.log(`  ${ok ? 'ok ' : 'BAD'} ${c.kind.padEnd(9)} ${c.id.padEnd(34)} ${j.score}/5  ${j.reason}`)
  }
  const refs = rows.filter((r) => r.kind === 'reference')
  const ugly = rows.filter((r) => r.kind === 'ugly')
  const summary = `references ≥ ${JUDGE_THRESHOLD}: ${refs.filter((r) => r.ok).length}/${refs.length}; ugly edits ≤ 2: ${ugly.filter((r) => r.ok).length}/${ugly.length}; ${(cost / Math.max(1, rows.filter((r) => r.costUsd).length)).toFixed(5)} $ per judgement`
  if (!only) fs.writeFileSync(CALIBRATION_RESULT, JSON.stringify({ at: new Date().toISOString(), model: process.env.PLEATKIT_JUDGE_MODEL ?? JUDGE_MODEL, threshold: JUDGE_THRESHOLD, summary, costUsd: cost, rows }, null, 2) + '\n')
  o.log(`wrote ${path.relative(REPO_ROOT, CALIBRATION_RESULT).replace(/\\/g, '/')}`)
  return { ok: rows.every((r) => r.ok), summary, costUsd: cost, rows }
}
