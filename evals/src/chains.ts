import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PROMPT_VERSION, RecordingProvider, runAgent, type ModelProvider, type TypecheckFn } from '@pleatkit/agent'
import { MemoryStore, PleatkitEngine } from '@pleatkit/runtime'
import type { AgentRunRequest, FileMap, PleatkitManifest } from '@pleatkit/runtime/compiler'
import { APPS, routeOf, type AppId } from './apps.js'
import type { EvalBudget } from './budget.js'
import { finalFiles, gradeCheck, gradeInvariants, gradeRun, type RunResult } from './graders.js'
import type { BrowserCase, BrowserGrader } from './runner.js'
import { digestsOf } from './runner.js'
import { EVALS_DIR, prepareTask } from './tasks.js'
import type { BrowserInvariants, EvalTask, GraderResult, TaskInvariants } from './types.js'

/**
 * Edit chains (DECISIONS 75 Р3, brainstorm 16 part 2 item 3): 3 to 5 edits on one app, each applied on top of the
 * previous one, the way a real user's third edit lands on the first two. After every step the text invariants of all
 * earlier steps are checked again on the current files (a regression inside the session); then one edit from the
 * middle is taken back with the runtime's `engine.revert` (mechanically when no later edit touched its files, otherwise
 * by the agent with `revert` in the request, as the drawer does), and the reverted step must be gone while every later
 * step stays. The final and the reverted states are rendered by the browser grader.
 */
export const CHAINS_DIR = path.join(EVALS_DIR, 'chains')

export interface ChainStep {
  request: string
  locale?: 'en' | 'ru'
  expected: EvalTask['expected']
  /** Text invariants and browser checks of this step (re-checked after every later step: files and anyMustMatch). */
  invariants?: TaskInvariants
}

export interface Chain {
  id: string
  app: AppId
  title: string
  steps: ChainStep[]
  /** Take back step `step` (1-based, not the last) after the chain; its patterns must be gone, later steps stay. */
  revert: { step: number; request?: string; anyMustNotMatch: string[]; browser?: BrowserInvariants }
  budgetUsd?: number
}

export interface ChainStepRun {
  step: number
  request: string
  verdict: string | null
  pass: boolean
  graders: GraderResult[]
  /** Earlier steps whose invariants no longer hold after this step. */
  regressions: string[]
  costUsd: number
  modelCalls: number
  ms: number
}

export interface ChainRun {
  chainId: string
  app: AppId
  title: string
  steps: ChainStepRun[]
  revert: { step: number; how: 'mechanical' | 'agent' | 'not-run'; pass: boolean; problems: string[]; costUsd: number }
  browser: { final: GraderResult | null; reverted: GraderResult | null }
  pass: boolean
  costUsd: number
}

export function loadChains(only?: string[]): Chain[] {
  if (!fs.existsSync(CHAINS_DIR)) return []
  return fs
    .readdirSync(CHAINS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(CHAINS_DIR, f), 'utf8')) as Chain)
    .filter((c) => !only?.length || only.some((o) => c.id.startsWith(o)))
}

export const chainRecording = (dir: string, chainId: string, part: string): string => path.join(dir, `${chainId}.${part}.t1.jsonl`)

/** A step as an eval task, so the usual prepare and graders apply. */
const stepTask = (c: Chain, i: number): EvalTask => ({ id: `${c.id}-s${i + 1}`, app: c.app, title: `${c.title}: step ${i + 1}`, request: c.steps[i]!.request, ...(c.steps[i]!.locale ? { locale: c.steps[i]!.locale } : {}), expected: c.steps[i]!.expected, ...(c.steps[i]!.invariants ? { invariants: c.steps[i]!.invariants } : {}) })

/** An engine in Node over a memory store: compile and load are stubs (the graders and the browser check the code). */
function nodeEngine(manifest: PleatkitManifest): PleatkitEngine {
  const fallback = Object.fromEntries(manifest.dynamic.map((f) => [f.path, { default: () => null }]))
  const anyPanel = new Proxy({}, { get: () => ({ default: () => null }) }) as Record<string, Record<string, unknown>>
  return new PleatkitEngine({
    store: new MemoryStore(),
    userId: 'eval-chain',
    config: { manifest, externals: {}, fallback, wasmURL: null } as never,
    compiler: { compile: async (files: FileMap) => ({ ok: true, errors: [], warnings: [], hash: String(Object.keys(files).length), timeMs: 0, bundle: { js: 'export const modules = {}', css: '' } }), metrics: {} } as never,
    loader: async () => anyPanel as never,
    bootStorage: null,
  } as never)
}

async function commit(engine: PleatkitEngine, before: FileMap, after: FileMap, message: string): Promise<string> {
  engine.draft.start(message)
  for (const [p, s] of Object.entries(after)) if (before[p] !== s) engine.draft.write(p, s)
  for (const p of Object.keys(before)) if (!(p in after)) engine.draft.remove(p)
  return (await engine.draft.commit('agent')).id
}

/** Text invariants of a step that still make sense on later files: what must be in the files (not forbidden/unchanged). */
const lasting = (inv?: TaskInvariants): TaskInvariants => ({ ...(inv?.files ? { files: inv.files } : {}), ...(inv?.anyMustMatch ? { anyMustMatch: inv.anyMustMatch } : {}) })

export interface ChainOptions {
  chains: Chain[]
  manifests: Partial<Record<AppId, PleatkitManifest>>
  /** The model for a part of a chain (`s1`, `s2`, …, `revert`): live, or a replay of its recording. */
  providerFor: (chain: Chain, part: string) => ModelProvider
  recordDir?: string
  budget: EvalBudget
  typecheckFor: (app: AppId) => TypecheckFn | null
  loopTypecheckFor: (app: AppId) => TypecheckFn | null
  browser: BrowserGrader | null
  log: (l: string) => void
}

export async function runChains(o: ChainOptions): Promise<ChainRun[]> {
  const out: ChainRun[] = []
  const cases: BrowserCase[] = []
  for (const c of o.chains) {
    const manifest = o.manifests[c.app]!
    const engine = nodeEngine(manifest)
    await engine.init()
    let files: FileMap = Object.fromEntries(manifest.dynamic.map((f) => [f.path, f.source]))
    const snaps: string[] = []
    const steps: ChainStepRun[] = []
    let cost = 0
    const run = async (part: string, req: AgentRunRequest, trusted: ReturnType<typeof prepareTask>['trusted']): Promise<RunResult> => {
      let provider = o.providerFor(c, part)
      let tmp: string | null = null
      if (o.recordDir) {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-chain-rec-'))
        provider = new RecordingProvider(provider, { dir: tmp, taskId: `${c.id}.${part}` })
      }
      const limit = o.budget.limitFor(c.budgetUsd ?? 0.4)
      const r = await runAgent(req, provider, { limits: { maxCostUsd: limit }, protected: trusted.protected, base: trusted.base, typecheck: o.loopTypecheckFor(c.app), digests: digestsOf(manifest) })
      if (o.recordDir && tmp) {
        const written = (provider as RecordingProvider).files
        fs.mkdirSync(o.recordDir, { recursive: true })
        if (written.length) fs.writeFileSync(chainRecording(o.recordDir, c.id, part), written.map((f) => fs.readFileSync(f, 'utf8')).join(''))
        fs.rmSync(tmp, { recursive: true, force: true })
      }
      const usd = r.usage.reduce((s, u) => s + (u.costUsd ?? 0), 0)
      o.budget.charge(usd)
      cost += usd
      return r
    }

    for (let i = 0; i < c.steps.length; i++) {
      o.budget.admit(`${c.id}.s${i + 1}`)
      const task = stepTask(c, i)
      const p = prepareTask(task, manifest, files)
      const r = await run(`s${i + 1}`, p.request, p.trusted)
      const graders = await gradeRun(p, r, o.typecheckFor(c.app))
      const after = finalFiles(files, r)
      if (Object.keys(r.files).length || r.deleted.length) snaps[i] = await commit(engine, files, after, `step ${i + 1}: ${c.steps[i]!.request}`.slice(0, 200))
      files = after
      // every earlier step's lasting invariants, on the files as they are now
      const regressions: string[] = []
      for (let j = 0; j < i; j++) {
        const inv = lasting(c.steps[j]!.invariants)
        if (!inv.files && !inv.anyMustMatch) continue
        const g = gradeInvariants({ ...p, task: { ...stepTask(c, j), invariants: inv }, start: files }, { ...r, files: {}, deleted: [] })
        if (!g.pass) regressions.push(`step ${j + 1}: ${g.reason}`)
      }
      const pass = graders.every((g) => g.pass) && !regressions.length
      steps.push({ step: i + 1, request: c.steps[i]!.request, verdict: r.verdict, pass, graders, regressions, costUsd: r.usage.reduce((s, u) => s + (u.costUsd ?? 0), 0), modelCalls: r.modelCalls, ms: r.timings.totalMs })
      o.log(`${c.id} step ${i + 1}: ${r.verdict}${pass ? '' : ` FAIL ${[...graders.filter((g) => !g.pass).map((g) => g.grader), ...regressions.map(() => 'regression')].join(', ')}`}`)
    }

    // take back one step from the middle with the runtime's revert
    const k = c.revert.step
    const problems: string[] = []
    let how: ChainRun['revert']['how'] = 'not-run'
    let reverted: FileMap | null = null
    const target = snaps[k - 1]
    if (!target) problems.push(`step ${k} changed nothing, so there is nothing to take back`)
    else {
      const plan = await engine.revertPlan(target)
      if (plan.files) {
        how = 'mechanical'
        const s = await engine.revert(target)
        reverted = s?.files ?? plan.files
      } else {
        how = 'agent'
        o.budget.admit(`${c.id}.revert`)
        const task = { ...stepTask(c, k - 1), id: `${c.id}-revert`, request: c.revert.request ?? `Undo this earlier change: ${c.steps[k - 1]!.request}`, expected: { verdict: 'ok' as const, change: true } }
        const p = prepareTask(task, manifest, files, plan.revert)
        const r = await run('revert', p.request, p.trusted)
        if (r.verdict !== 'ok') problems.push(`the agent answered ${r.verdict} to the revert`)
        reverted = finalFiles(files, r)
        const chk = await gradeCheck(p, r)
        if (!chk.pass) problems.push(`check after the revert: ${chk.reason.slice(0, 200)}`)
      }
    }
    if (reverted) {
      for (const re of c.revert.anyMustNotMatch) if (Object.values(reverted).some((s) => new RegExp(re, 'm').test(s))) problems.push(`step ${k} is still there (/${re}/)`)
      for (let j = k; j < c.steps.length; j++) {
        const inv = lasting(c.steps[j]!.invariants)
        if (!inv.files && !inv.anyMustMatch) continue
        const p = prepareTask(stepTask(c, j), manifest, reverted)
        const g = gradeInvariants({ ...p, task: { ...stepTask(c, j), invariants: inv } }, { files: {}, deleted: [] } as unknown as RunResult)
        if (!g.pass) problems.push(`step ${j + 1} was lost by the revert: ${g.reason}`)
      }
    }

    // the final and the reverted states in the browser: every step's checks, then the revert's and the later steps'
    const route = (inv?: BrowserInvariants) => inv?.path ?? routeOf(c.app, inv?.checks.find((x) => x.panel)?.panel)
    const allChecks = c.steps.flatMap((s) => s.invariants?.browser?.checks ?? [])
    const first = c.steps.find((s) => s.invariants?.browser)?.invariants?.browser
    const appCase = (inv: BrowserInvariants) => (c.app !== 'demo-crm' ? { app: c.app, path: route(inv), panels: APPS[c.app].panels[route(inv)] ?? [] } : {})
    const base = Object.fromEntries(manifest.dynamic.map((f) => [f.path, f.source]))
    const diff = (to: FileMap) => ({ files: Object.fromEntries(Object.entries(to).filter(([p, s]) => base[p] !== s)), deleted: Object.keys(base).filter((p) => !(p in to)) })
    if (allChecks.length && first) {
      const inv = { ...first, checks: allChecks }
      cases.push({ taskId: `${c.id}.final`, ...appCase(inv), ...diff(files), invariants: inv })
    }
    if (reverted) {
      const later = c.steps.slice(k).flatMap((s) => s.invariants?.browser?.checks ?? [])
      const checks = [...(c.revert.browser?.checks ?? []), ...later]
      if (checks.length) {
        const inv = { ...(c.revert.browser ?? first ?? { checks: [] }), checks }
        cases.push({ taskId: `${c.id}.reverted`, ...appCase(inv), ...diff(reverted), invariants: inv })
      }
    }
    out.push({ chainId: c.id, app: c.app, title: c.title, steps, revert: { step: k, how, pass: !problems.length, problems, costUsd: 0 }, browser: { final: null, reverted: null }, pass: false, costUsd: cost })
    o.log(`${c.id} revert step ${k} (${how}): ${problems.length ? `FAIL ${problems.join('; ')}` : 'ok'}`)
  }

  const results = o.browser && cases.length ? await o.browser(cases) : {}
  for (const r of out) {
    r.browser = { final: results[`${r.chainId}.final`] ?? null, reverted: results[`${r.chainId}.reverted`] ?? null }
    const browserOk = !o.browser || [r.browser.final, r.browser.reverted].every((g) => !g || g.pass)
    r.pass = r.steps.every((s) => s.pass) && r.revert.pass && browserOk
  }
  return out
}

export const chainsPromptVersion = PROMPT_VERSION
