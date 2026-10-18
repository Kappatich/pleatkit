import { createTypechecker, Workspace, formatErrors, type TypecheckFn } from '@pleatkit/agent'
import type { AgentResult, FileMap } from '@pleatkit/runtime/compiler'
import { PREDICATES } from './predicates.js'
import type { PreparedTask } from './tasks.js'
import type { EvalTask, GraderResult } from './types.js'

export type RunResult = Omit<AgentResult, 'requestId'>

/** The user's files after the result is applied (what the browser would commit). */
export function finalFiles(start: FileMap, result: Pick<RunResult, 'files' | 'deleted'>): FileMap {
  const out = { ...start, ...result.files }
  for (const p of result.deleted) delete out[p]
  return out
}

export function gradeVerdict(task: EvalTask, result: RunResult): GraderResult {
  const want = task.expected.verdict
  return result.verdict === want
    ? { grader: 'verdict', pass: true, reason: want }
    : { grader: 'verdict', pass: false, reason: `expected ${want}, got ${result.verdict}${result.stopReason ? ` (stopped: ${result.stopReason})` : ''}${result.error ? `: ${result.error.slice(0, 200)}` : ''}` }
}

export function gradeChange(task: EvalTask, result: RunResult): GraderResult {
  const n = Object.keys(result.files).length + result.deleted.length
  if (task.expected.change) return n > 0 ? { grader: 'change', pass: true, reason: `${n} file(s) changed` } : { grader: 'change', pass: false, reason: 'the task needs a change, nothing was changed' }
  return n === 0 ? { grader: 'change', pass: true, reason: 'nothing changed, as expected' } : { grader: 'change', pass: false, reason: `nothing should change, ${n} file(s) changed: ${Object.keys(result.files).join(', ')}` }
}

/** The shared `check` of @pleatkit/runtime (bundle, static rules, protected elements, default exports). */
export async function gradeCheck(p: PreparedTask, result: RunResult): Promise<GraderResult> {
  if (Object.keys(result.files).length + result.deleted.length === 0) return { grader: 'check', pass: true, skipped: true, reason: 'nothing changed' }
  const ws = new Workspace({ ...p.request, files: finalFiles(p.start, result), protected: p.trusted.protected, base: p.trusted.base })
  const r = await ws.check()
  return r.ok ? { grader: 'check', pass: true, reason: `compiles, static rules pass (${Math.round(r.timeMs)} ms)` } : { grader: 'check', pass: false, reason: formatErrors(r.errors) }
}

/** `tsc` over the dynamic files with the app's readonly sources and `.d.ts`, packages from `root`'s node_modules. */
export async function gradeTypecheck(p: PreparedTask, result: RunResult, typecheck: TypecheckFn | null): Promise<GraderResult> {
  if (!typecheck) return { grader: 'typecheck', pass: true, skipped: true, reason: 'PLEATKIT_TYPECHECK_ROOT is not set' }
  if (Object.keys(result.files).length === 0) return { grader: 'typecheck', pass: true, skipped: true, reason: 'nothing changed' }
  const errors = await typecheck(finalFiles(p.start, result), { ...p.request, protected: p.trusted.protected, base: p.trusted.base })
  return errors.length ? { grader: 'typecheck', pass: false, reason: formatErrors(errors) } : { grader: 'typecheck', pass: true, reason: 'no type errors' }
}

export function typecheckerFromEnv(env: Record<string, string | undefined> = process.env): TypecheckFn | null {
  const root = env.PLEATKIT_TYPECHECK_ROOT
  return root ? createTypechecker({ root }) : null
}

/** Text invariants: files that must keep testids and props, forbidden patterns, files that must stay as they were. */
export function gradeInvariants(p: PreparedTask, result: RunResult): GraderResult {
  const inv = p.task.invariants
  if (!inv || (!inv.files?.length && !inv.forbidden?.length && !inv.unchanged?.length && !inv.anyMustMatch?.length)) return { grader: 'invariants', pass: true, skipped: true, reason: 'no text invariants' }
  const final = finalFiles(p.start, result)
  const problems: string[] = []
  for (const f of inv.files ?? []) {
    const src = final[f.path]
    if (src === undefined) {
      problems.push(`${f.path} does not exist`)
      continue
    }
    for (const s of f.mustContain ?? []) if (!src.includes(s)) problems.push(`${f.path} lost ${JSON.stringify(s)}`)
    for (const s of f.mustNotContain ?? []) if (src.includes(s)) problems.push(`${f.path} contains ${JSON.stringify(s)}`)
    for (const r of f.mustMatch ?? []) if (!new RegExp(r, 'm').test(src)) problems.push(`${f.path} does not match /${r}/`)
    for (const r of f.mustNotMatch ?? []) if (new RegExp(r, 'm').test(src)) problems.push(`${f.path} matches /${r}/`)
  }
  for (const r of inv.forbidden ?? []) {
    const re = new RegExp(r, 'm')
    for (const [path, src] of Object.entries(result.files)) if (re.test(src)) problems.push(`${path} has the forbidden pattern /${r}/`)
  }
  for (const r of inv.anyMustMatch ?? []) {
    const re = new RegExp(r, 'm')
    if (!Object.values(final).some((src) => re.test(src))) problems.push(`no dynamic file matches /${r}/`)
  }
  for (const path of inv.unchanged ?? []) if (path in result.files || result.deleted.includes(path)) problems.push(`${path} was changed`)
  return problems.length ? { grader: 'invariants', pass: false, reason: problems.join('; ') } : { grader: 'invariants', pass: true, reason: 'all text invariants hold' }
}

export function gradePredicates(p: PreparedTask, result: RunResult): GraderResult {
  const names = p.task.invariants?.predicates ?? []
  if (!names.length) return { grader: 'predicates', pass: true, skipped: true, reason: 'no predicates' }
  const final = finalFiles(p.start, result)
  const problems: string[] = []
  for (const name of names) {
    const pred = PREDICATES[name]
    if (!pred) {
      problems.push(`unknown predicate "${name}"`)
      continue
    }
    const why = pred.check({ task: p.task, result, final, changed: result.files })
    if (why) problems.push(`${name}: ${why}`)
  }
  return problems.length ? { grader: 'predicates', pass: false, reason: problems.join('; ') } : { grader: 'predicates', pass: true, reason: names.join(', ') }
}

/** Every grader that runs in-process (the browser grader runs afterwards, for all tasks at once). */
export async function gradeRun(p: PreparedTask, result: RunResult, typecheck: TypecheckFn | null): Promise<GraderResult[]> {
  return [gradeVerdict(p.task, result), gradeChange(p.task, result), await gradeCheck(p, result), await gradeTypecheck(p, result, typecheck), gradeInvariants(p, result), gradePredicates(p, result)]
}
