import fs from 'node:fs'
import path from 'node:path'
import { classifierContext, configFromEnv, costUsd, PROMPT_VERSION, readTranscript, settledOf, type Classification } from '@pleatkit/agent'
import { digestsOf } from './runner.js'
import { loadManifests, loadSuites, prepareTask, REPO_ROOT, RESULTS_DIR, setDir, type Suite } from './tasks.js'
import type { AppId } from './apps.js'
import type { EvalTask } from './types.js'
import { recordingFile, trialsIn } from './providers.js'
import { classifiedRight, probeChanges, probeVerdict } from './probe-labels.js'

/**
 * `pnpm eval:classify -- --tasks apps --against <set>`: the classifier alone on every task it would see (no target,
 * no clarification), with today's prompt and the app's data contract, next to the label the set recorded. A
 * classifier change measured for the price of the small model (a few hundredths of a dollar), before any edit runs.
 * Needs PLEATKIT_API_KEY; writes evals/results/classify-<set>.json.
 *
 * Stage 5 block 3 (DECISIONS 74.5): `--probes <file>` adds requests that are not tasks (`evals/probes/*.json`: id, app,
 * request, expected label), `--only` picks tasks, `--repeat n` asks the classifier n times per request (Haiku is noisy
 * on mixed requests: one answer per request says little), `--out <name>` names the result file.
 *
 * Stage 5 block 5 (DECISIONS 81): probes may carry the labels of the /admin Labels screen (`pleatkit labels export`):
 * `clarify`, `declined` and `mixed` are scored as `probe-labels.ts` says; their extra fields (suggested, labeledBy,
 * labeledAt) are ignored.
 *
 * Stage 5 block 6 (DECISIONS 83): `--provider haiku|ensemble` picks the classifier (`ensemble`: Jev and Haiku together,
 * `PLEATKIT_CLASSIFIER_ENSEMBLE=jev`, needs TYPESAFE_API_KEY; `haiku`: the model alone, whatever the environment says).
 * `--probes` takes several files (comma-separated). Every row has the routing decision's latency (`ms`: until the
 * classification is returned, as the agent loop waits for it), who decided and Jev's answer; the summary has the median
 * and p95 latency and the cost by model, including the classifier model's call that finished after Jev decided. The
 * static and runtime red-team tasks (`rt-s-*`, `rt-r-*`) are skipped: their request is a placeholder, the attack is in
 * the scripted answer.
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const value = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined)
  const tasksArg = value('tasks') ?? 'apps'
  const suites = (tasksArg === 'all' ? ['demo', 'apps'] : tasksArg.split(',')) as Suite[]
  const against = value('against')
  if (!process.env.PLEATKIT_API_KEY) {
    console.error('eval:classify calls the classifier model: set PLEATKIT_API_KEY')
    return 2
  }
  const which = value('provider')
  if (which && which !== 'haiku' && which !== 'ensemble') {
    console.error('--provider must be haiku or ensemble')
    return 2
  }
  const env = which === 'ensemble' ? { ...process.env, PLEATKIT_CLASSIFIER_ENSEMBLE: 'jev' } : which === 'haiku' ? { ...process.env, PLEATKIT_CLASSIFIER_ENSEMBLE: 'off' } : process.env
  const provider = configFromEnv(env).provider
  const only = value('only')?.split(',')
  const probesFile = value('probes')
  const repeat = Math.max(1, Number(value('repeat') ?? 1))
  const withTasks = !probesFile || only || args.includes('--tasks')
  const tasks: EvalTask[] = (withTasks ? loadSuites(suites, only) : []).filter((t) => !t.target && !t.clarification && !t.migration && !/^rt-[sr]-/.test(t.id))
  for (const one of probesFile?.split(',') ?? []) {
    const file = path.resolve(process.env.INIT_CWD ?? REPO_ROOT, one)
    const probes = (JSON.parse(fs.readFileSync(file, 'utf8')) as { probes: { id: string; app: AppId; request: string; expected: string }[] }).probes
    // a probe is a task with only a request: the label it should get is its expected "verdict" (ui → the main model)
    for (const p of probes) tasks.push({ id: p.id, app: p.app, title: p.id, scenario: 'classifier probe', request: p.request, expected: { verdict: probeVerdict(p.expected) as 'needs-backend', change: probeChanges(p.expected) } } as EvalTask)
  }
  const manifests = loadManifests(tasks)
  const rows: Record<string, unknown>[] = []
  let cost = 0
  // the classifier's prompt cache (stage 5 block 3): input tokens read from the cache, written to it, and uncached
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0 }
  const byModel: Record<string, number> = {}
  const latencies: number[] = []
  const add = (model: string | null, usage: Classification['usage']) => {
    if (!model || !usage) return 0
    const usd = costUsd(model, usage) ?? 0
    cost += usd
    const key = model.startsWith('jev-') ? 'jev' : model
    byModel[key] = (byModel[key] ?? 0) + usd
    if (!key.startsWith('jev')) {
      tokens.input += usage.inputTokens
      tokens.cacheRead += usage.cacheReadTokens
      tokens.cacheWrite += usage.cacheWriteTokens
    }
    return usd
  }
  for (const t of tasks) for (let n = 1; n <= repeat; n++) {
    const p = prepareTask(t, manifests[t.app]!)
    const t0 = performance.now()
    let c: Classification
    try {
      c = await provider.classify({ request: p.request.request, context: classifierContext(p.request, digestsOf(manifests[t.app]!)) }, AbortSignal.timeout(30_000))
    } catch (e) {
      // block 7: a classifier that times out or errors counts as a wrong label (the run goes on); its cost is unknown
      const ms = Math.round(performance.now() - t0)
      latencies.push(ms)
      rows.push({ task: t.id, ...(repeat > 1 ? { n } : {}), expected: t.expected.verdict, before: null, now: 'error/', ms, usd: 0, error: (e as Error).message.slice(0, 300) })
      console.log(`${t.id.padEnd(44)} expected ${t.expected.verdict.padEnd(13)} ERROR ${(e as Error).message.slice(0, 120)}`)
      continue
    }
    const ms = Math.round(performance.now() - t0)
    latencies.push(ms)
    let usd = add(c.model, c.usage)
    for (const x of c.extraUsage ?? []) usd += add(x.model, x.usage)
    // the classifier model's call that ended after Jev decided is paid too
    const late = settledOf(c)
    const lateModel = late ? await late : null
    if (lateModel) usd += add(lateModel.model, lateModel.usage)
    let before: string | null = null
    if (against) {
      const dir = setDir(against)
      const n = trialsIn(t.id, dir)[0]
      const file = n === undefined ? null : recordingFile(t.id, dir, n)
      const line = file && fs.existsSync(file) ? readTranscript(file).find((l) => l.kind === 'classify') : undefined
      before = line && line.kind === 'classify' ? `${line.output.label}/${line.output.intentLabel ?? ''}` : null
    }
    const now = `${c.label}/${c.intentLabel ?? ''}`
    const jev = c.ensemble?.jev
    rows.push({ task: t.id, ...(repeat > 1 ? { n } : {}), expected: t.expected.verdict, before, now, ms, usd, ...(c.ensemble ? { decidedBy: c.ensemble.decidedBy, jev } : {}), ...(lateModel ? { lateModel: `${lateModel.label}/${lateModel.intentLabel ?? ''}` } : {}), reason: c.reason, ...(c.question ? { question: c.question } : {}) })
    const who = c.ensemble ? ` [${c.ensemble.decidedBy}${jev ? ` jev ${jev.route} ${jev.confidence.toFixed(2)} adv ${jev.adversarial?.toFixed(2) ?? '-'}` : ''}]` : ''
    console.log(`${t.id.padEnd(44)} expected ${t.expected.verdict.padEnd(13)} ${before ? `before ${before.padEnd(30)} ` : ''}now ${now.padEnd(28)} ${String(ms).padStart(5)} ms${who}`)
  }
  fs.mkdirSync(RESULTS_DIR, { recursive: true })
  const out = path.join(RESULTS_DIR, `classify-${value('out') ?? against ?? suites.join('-')}.json`)
  // right when the label sends the request where its expected verdict needs it (ok/partial → ui, the others by name)
  const right = rows.filter((r) => classifiedRight(String(r.expected), String(r.now))).length
  const all = tokens.input + tokens.cacheRead + tokens.cacheWrite
  const sorted = [...latencies].sort((a, b) => a - b)
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0
  const latency = { medianMs: pick(0.5), p95Ms: pick(0.95) }
  const jevRows = rows.filter((r) => r.decidedBy === 'jev')
  const ensemble = rows.some((r) => r.decidedBy) ? { decidedByJev: jevRows.length, jevRight: jevRows.filter((r) => classifiedRight(String(r.expected), String(r.now))).length } : undefined
  console.log(`routing decision: median ${latency.medianMs} ms, p95 ${latency.p95Ms} ms; cost by model ${Object.entries(byModel).map(([m, v]) => `${m} $${v.toFixed(5)}`).join(', ')}${ensemble ? `; Jev decided ${ensemble.decidedByJev} (${ensemble.jevRight} right)` : ''}`)
  console.log(`right: ${right} of ${rows.length}; classifier input ${all} tokens: cache read ${tokens.cacheRead} (${all ? Math.round((tokens.cacheRead / all) * 1000) / 10 : 0} %), cache write ${tokens.cacheWrite}, uncached ${tokens.input}`)
  fs.writeFileSync(out, JSON.stringify({ promptVersion: PROMPT_VERSION, at: new Date().toISOString(), provider: which ?? 'env', costUsd: cost, byModel, latency, ...(ensemble ? { ensemble } : {}), repeat, right, tokens, rows }, null, 2) + '\n')
  console.log(`${rows.length} classifications, prompt ${PROMPT_VERSION}, $${cost.toFixed(4)}; ${path.relative(process.cwd(), out)}`)
  return 0
}

main().then(
  (code) => process.exit(code),
  (e: Error) => {
    console.error(e.message)
    process.exit(1)
  },
)
