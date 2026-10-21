import fs from 'node:fs'
import path from 'node:path'
import { median, percentile, seriesMetrics } from './metrics.js'
import { RECORDINGS_DIR } from './tasks.js'
import type { SuiteResult, TaskRun } from './types.js'

/**
 * Stage 5 block 7 (DECISIONS 78): the model matrix's tables. Each set is one editor on demo + apps + awkward × 1,
 * recorded live without the browser (`<set>/record.json`: the real latencies and costs) and then replayed with the
 * browser grader and the judge (`<set>/graded.json`: the pass and the judge). `pnpm --filter @pleatkit/evals matrix --
 * --sets matrix-sonnet,matrix-gpt-5-mini,… --reference matrix-sonnet` prints the tables in Markdown.
 */

export type Family = 'simple' | 'chart' | 'sort-filter' | 'computed' | 'mixed-server' | 'vague' | 'adversarial'

export const FAMILY_TITLES: Record<Family, string> = {
  simple: 'simple field, column, label and colour edits',
  chart: 'table or list → chart',
  'sort-filter': 'sorting, filtering, paging',
  computed: 'totals, averages, two asks, screenshot, carry-over',
  'mixed-server': 'mixed and server requests (partial, needs-backend)',
  vague: 'vague (a question is right)',
  adversarial: 'adversarial and out of scope (declined, refused, not editable)',
}

/** The task families of the decision table, by task id (the 69 tasks of demo, apps and awkward). */
export const FAMILY_OF: Readonly<Record<string, Family>> = Object.fromEntries(
  (
    [
      ['simple', 'crm-01 crm-03 crm-06 crm-14 sa-01 sa-02 sa-03 sa-05 sa-06 sa-11 sa-12 sa-18 ta-01 ta-04 ta-05 ta-07 ta-10 ta-11 ta-12 aw-01 aw-02 aw-11 aw-12 aw-18 aw-19'],
      ['chart', 'sa-08 sa-09 ta-06'],
      ['sort-filter', 'sa-04 sa-07 sa-10 ta-02 ta-03 ta-08 aw-13'],
      ['computed', 'crm-04 crm-07 crm-08 crm-13 ta-09 aw-03 aw-05 aw-07 aw-09 aw-10 aw-20'],
      ['mixed-server', 'crm-02 crm-10 sa-13 sa-14 sa-15 ta-13 aw-14 aw-16 aw-17'],
      ['vague', 'crm-05 sa-16 ta-14 aw-04 aw-06 aw-08'],
      ['adversarial', 'crm-09 crm-11 crm-12 sa-17 ta-15 ta-16 ta-17 aw-15'],
    ] as [Family, string][]
  ).flatMap(([f, ids]) => ids.split(' ').map((id) => [id, f])),
)

/** `crm-01-card-fields` → `crm-01`. */
export const shortId = (taskId: string): string => taskId.split('-').slice(0, 2).join('-')
export const familyOf = (taskId: string): Family | undefined => FAMILY_OF[shortId(taskId)]
export const suiteOf = (taskId: string): 'demo' | 'apps' | 'awkward' => (taskId.startsWith('crm-') ? 'demo' : taskId.startsWith('aw-') ? 'awkward' : 'apps')

export interface MatrixRow {
  set: string
  model: string
  runs: number
  /** Planned runs that did not run (budget, `--min-pass`). */
  notRun: number
  stoppedBecause?: string
  pass: { demo: [number, number]; apps: [number, number]; awkward: [number, number]; all: [number, number] }
  byFamily: Partial<Record<Family, [number, number]>>
  graders: Record<string, [number, number]>
  firstTry: [number, number]
  medianCalls: number
  editLatencyMs: { median: number; p95: number }
  costPerEdit: { median: number; p95: number }
  costTotal: number
  /** Judge: accepted (score ≥ 4) of judged edits, and the mean score. */
  judge: { accept: number; judged: number; mean: number | null }
  failures: { taskId: string; verdict: string | null; graders: string[] }[]
  /** Block 8: per task (short id), the passes of its runs (trials). */
  perTask: Record<string, [number, number]>
}

const pair = (runs: TaskRun[]): [number, number] => [runs.filter((r) => r.pass).length, runs.length]

/** One row of the matrix from a set's live record and (when there) its graded replay. */
export function matrixRow(set: string, record: SuiteResult, graded: SuiteResult | null): MatrixRow {
  const live = record.runs
  // the graded replay decides the pass (it ran the browser grader); the record has the real latencies and costs
  const passRuns = graded ? graded.runs : live
  const m = seriesMetrics(record)
  const bySuite = (s: string) => pair(passRuns.filter((r) => suiteOf(r.taskId) === s))
  const byFamily: MatrixRow['byFamily'] = {}
  for (const r of passRuns) {
    const f = familyOf(r.taskId)
    if (!f) continue
    const [p, n] = byFamily[f] ?? [0, 0]
    byFamily[f] = [p + (r.pass ? 1 : 0), n + 1]
  }
  const graders: Record<string, [number, number]> = {}
  for (const r of passRuns) for (const g of r.graders) {
    if (g.skipped || g.advisory) continue
    const [p, n] = graders[g.grader] ?? [0, 0]
    graders[g.grader] = [p + (g.pass ? 1 : 0), n + 1]
  }
  const perTask: Record<string, [number, number]> = {}
  for (const r of passRuns) {
    const [p, n] = perTask[shortId(r.taskId)] ?? [0, 0]
    perTask[shortId(r.taskId)] = [p + (r.pass ? 1 : 0), n + 1]
  }
  const edits = live.filter((r) => r.changedFiles.length > 0)
  const judged = passRuns.filter((r) => r.judge)
  const wrote = live.filter((r) => r.firstTry !== null)
  return {
    set,
    model: record.runs.find((r) => r.model)?.model ?? '?',
    runs: live.length,
    notRun: record.aborted?.notRun.length ?? 0,
    ...(record.aborted ? { stoppedBecause: record.aborted.reason } : {}),
    pass: { demo: bySuite('demo'), apps: bySuite('apps'), awkward: bySuite('awkward'), all: pair(passRuns) },
    byFamily,
    graders,
    firstTry: [wrote.filter((r) => r.firstTry).length, wrote.length],
    medianCalls: m.modelCalls.median,
    editLatencyMs: { median: median(edits.map((r) => r.ms)), p95: percentile(edits.map((r) => r.ms), 95) },
    costPerEdit: { median: median(edits.map((r) => r.costUsd)), p95: percentile(edits.map((r) => r.costUsd), 95) },
    costTotal: live.reduce((s, r) => s + r.costUsd, 0),
    judge: { accept: judged.filter((r) => r.judge!.accept).length, judged: judged.length, mean: judged.length ? judged.reduce((s, r) => s + r.judge!.score, 0) / judged.length : null },
    failures: passRuns.filter((r) => !r.pass).map((r) => ({ taskId: r.taskId, verdict: r.verdict, graders: r.graders.filter((g) => !g.pass && !g.skipped && !g.advisory).map((g) => g.grader) })),
    perTask,
  }
}

/** Block 8: the tasks two sets do not pass equally often (by pass share of their trials), in task order. */
export function disagreements(a: MatrixRow, b: MatrixRow): { task: string; a: [number, number]; b: [number, number] }[] {
  const rate = ([p, n]: [number, number]) => (n ? p / n : 0)
  return Object.keys(a.perTask)
    .filter((t) => b.perTask[t] && rate(a.perTask[t]!) !== rate(b.perTask[t]!))
    .sort()
    .map((task) => ({ task, a: a.perTask[task]!, b: b.perTask[task]! }))
}

export interface DefaultRuleCheck {
  what: string
  reference: number
  candidate: number
  ok: boolean
}

/**
 * DECISIONS 73.2 and 86.1 (block 8): a cheaper editor becomes the BYOK default only if its pass rate is within
 * `passPoints` (1) percentage points of the reference's on every set, its first-try rate within `firstTryPoints` (3),
 * and its edit latency p95 is under `p95Ms` (12 s). "Within" is one-sided: a candidate better than the reference passes.
 */
export function byokDefaultRule(ref: MatrixRow, cand: MatrixRow, o: { passPoints?: number; firstTryPoints?: number; p95Ms?: number } = {}): { switch: boolean; checks: DefaultRuleCheck[] } {
  const passPoints = o.passPoints ?? 1
  const firstTryPoints = o.firstTryPoints ?? 3
  const p95Ms = o.p95Ms ?? 12_000
  const pts = ([p, n]: [number, number]) => (n ? (p / n) * 100 : 0)
  const checks: DefaultRuleCheck[] = (['demo', 'apps', 'awkward'] as const).map((s) => ({ what: `pass ${s} (points)`, reference: pts(ref.pass[s]), candidate: pts(cand.pass[s]), ok: pts(cand.pass[s]) >= pts(ref.pass[s]) - passPoints }))
  checks.push({ what: 'first try (points)', reference: pts(ref.firstTry), candidate: pts(cand.firstTry), ok: pts(cand.firstTry) >= pts(ref.firstTry) - firstTryPoints })
  checks.push({ what: 'edit latency p95 (ms)', reference: ref.editLatencyMs.p95, candidate: cand.editLatencyMs.p95, ok: cand.editLatencyMs.p95 < p95Ms })
  return { switch: checks.every((c) => c.ok), checks }
}

/**
 * The decision table: per family, the cheapest model (by median cost per edit over the whole set, the reference's
 * own included) whose pass share in that family is at least `keep` (0.97) of the reference's.
 */
export function cheapestPerFamily(rows: MatrixRow[], reference: string, keep = 0.97): Record<Family, { model: string; set: string; pass: [number, number]; refPass: [number, number] } | null> {
  const ref = rows.find((r) => r.set === reference)
  const out = {} as Record<Family, { model: string; set: string; pass: [number, number]; refPass: [number, number] } | null>
  const rate = (p: [number, number] | undefined) => (p && p[1] ? p[0] / p[1] : 0)
  const byCost = [...rows].sort((a, b) => a.costPerEdit.median - b.costPerEdit.median)
  for (const f of Object.keys(FAMILY_TITLES) as Family[]) {
    const refPass = ref?.byFamily[f]
    if (!refPass) {
      out[f] = null
      continue
    }
    // a model stopped early (or short of runs) is measured on fewer tasks of the family: it must cover all of them
    const ok = byCost.find((r) => r.byFamily[f]?.[1] === refPass[1] && rate(r.byFamily[f]) >= keep * rate(refPass))
    out[f] = ok ? { model: ok.model, set: ok.set, pass: ok.byFamily[f]!, refPass } : null
  }
  return out
}

const pct = ([p, n]: [number, number]) => (n ? `${p}/${n} (${Math.round((p / n) * 1000) / 10} %)` : '—')
const usd = (x: number) => (x >= 0.01 ? `$${x.toFixed(3)}` : `$${x.toFixed(4)}`)
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`

export function markdown(rows: MatrixRow[], reference?: string): string {
  const lines: string[] = []
  lines.push('| Model | Demo | Apps | Awkward | All | First try | Calls (median) | Edit latency median / p95 | Cost per edit median / p95 | Judge accept (mean) | Total |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    lines.push(`| ${r.model}${r.notRun ? ` (stopped, ${r.notRun} not run)` : ''} | ${pct(r.pass.demo)} | ${pct(r.pass.apps)} | ${pct(r.pass.awkward)} | **${pct(r.pass.all)}** | ${pct(r.firstTry)} | ${r.medianCalls} | ${sec(r.editLatencyMs.median)} / ${sec(r.editLatencyMs.p95)} | ${usd(r.costPerEdit.median)} / ${usd(r.costPerEdit.p95)} | ${r.judge.accept}/${r.judge.judged}${r.judge.mean === null ? '' : ` (${r.judge.mean.toFixed(1)})`} | ${usd(r.costTotal)} |`)
  }
  const graders = [...new Set(rows.flatMap((r) => Object.keys(r.graders)))]
  lines.push('', `| Model | ${graders.join(' | ')} |`, `|---|${graders.map(() => '---').join('|')}|`)
  for (const r of rows) lines.push(`| ${r.model} | ${graders.map((g) => (r.graders[g] ? `${r.graders[g]![0]}/${r.graders[g]![1]}` : '—')).join(' | ')} |`)
  const families = Object.keys(FAMILY_TITLES) as Family[]
  lines.push('', `| Model | ${families.join(' | ')} |`, `|---|${families.map(() => '---').join('|')}|`)
  for (const r of rows) lines.push(`| ${r.model} | ${families.map((f) => (r.byFamily[f] ? `${r.byFamily[f]![0]}/${r.byFamily[f]![1]}` : '—')).join(' | ')} |`)
  if (reference) {
    const pick = cheapestPerFamily(rows, reference)
    lines.push('', '| Family | Reference | Cheapest at ≥ 97 % of it |', '|---|---|---|')
    for (const f of families) {
      const p = pick[f]
      lines.push(`| ${FAMILY_TITLES[f]} | ${p ? pct(p.refPass) : '—'} | ${p ? `${p.model} ${pct(p.pass)}` : 'none'} |`)
    }
  }
  lines.push('')
  for (const r of rows) if (r.failures.length) lines.push(`- ${r.model}: ${r.failures.map((f) => `${shortId(f.taskId)} ${f.verdict ?? 'error'} (${f.graders.join(', ') || 'browser'})`).join('; ')}`)
  return lines.join('\n')
}

const readJson = (file: string): SuiteResult | null => (fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as SuiteResult) : null)

/** Several sets as one row (`haiku-demo+haiku-apps+haiku-awkward`): their runs together. */
export function mergeSuites(parts: SuiteResult[]): SuiteResult {
  const notRun = parts.flatMap((p) => p.aborted?.notRun ?? [])
  return { ...parts[0]!, runs: parts.flatMap((p) => p.runs), judgeCostUsd: parts.reduce((t, p) => t + (p.judgeCostUsd ?? 0), 0), ...(notRun.length ? { aborted: { reason: parts.flatMap((p) => (p.aborted ? [p.aborted.reason] : [])).join('; '), notRun } } : {}) }
}

/** The rows of the named sets: `<set>/record.json` and, when there, `<set>/graded.json`; `a+b` is one row of both. */
export function loadMatrix(sets: string[], dir = RECORDINGS_DIR): MatrixRow[] {
  return sets.map((name) => {
    const parts = name.split('+')
    const records = parts.map((set) => readJson(path.join(dir, set, 'record.json')))
    const missing = parts.find((_, i) => !records[i])
    if (missing) throw new Error(`no ${missing}/record.json`)
    const graded = parts.map((set) => readJson(path.join(dir, set, 'graded.json')))
    return matrixRow(name, mergeSuites(records as SuiteResult[]), graded.every(Boolean) ? mergeSuites(graded as SuiteResult[]) : null)
  })
}

if (process.argv[1] && path.resolve(process.argv[1]).replace(/\.ts$/, '') === path.resolve(import.meta.dirname, 'matrix')) {
  const args = process.argv.slice(2)
  const value = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined)
  const sets = (value('sets') ?? '').split(',').filter(Boolean)
  if (!sets.length) {
    console.error('usage: tsx src/matrix.ts --sets a,b,c [--reference set] [--compare reference,candidate] [--json file]')
    process.exit(2)
  }
  const rows = loadMatrix(sets)
  console.log(markdown(rows, value('reference')))
  // block 8: `--compare reference,candidate` prints the per-task disagreements and the BYOK default rule
  const compare = value('compare')?.split(',')
  if (compare?.length === 2) {
    const [a, b] = compare.map((name) => rows.find((r) => r.set === name) ?? loadMatrix([name])[0]!) as [MatrixRow, MatrixRow]
    const d = disagreements(a, b)
    console.log(`
| Task | ${a.model} | ${b.model} |
|---|---|---|`)
    for (const x of d) console.log(`| ${x.task} | ${x.a[0]}/${x.a[1]} | ${x.b[0]}/${x.b[1]} |`)
    const rule = byokDefaultRule(a, b)
    console.log(`
Rule (DECISIONS 73.2, 86.1), ${b.model} against ${a.model}: ${rule.switch ? 'SWITCH' : 'KEEP the reference'}`)
    for (const c of rule.checks) console.log(`- ${c.what}: ${c.reference.toFixed(1)} → ${c.candidate.toFixed(1)} ${c.ok ? 'ok' : 'FAILS'}`)
  }
  const json = value('json')
  if (json) fs.writeFileSync(path.resolve(process.env.INIT_CWD ?? process.cwd(), json), JSON.stringify({ at: new Date().toISOString(), reference: value('reference') ?? null, rows }, null, 2) + '\n')
}
