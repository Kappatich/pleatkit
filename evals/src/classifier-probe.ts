import fs from 'node:fs'
import path from 'node:path'
import { classifierContext, configFromEnv, costUsd, PROMPT_VERSION, readTranscript } from '@pleatkit/agent'
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
  const provider = configFromEnv(process.env).provider
  const only = value('only')?.split(',')
  const probesFile = value('probes')
  const repeat = Math.max(1, Number(value('repeat') ?? 1))
  const tasks: EvalTask[] = (probesFile && !only ? [] : loadSuites(suites, only)).filter((t) => !t.target && !t.clarification && !t.migration)
  if (probesFile) {
    const file = path.resolve(process.env.INIT_CWD ?? REPO_ROOT, probesFile)
    const probes = (JSON.parse(fs.readFileSync(file, 'utf8')) as { probes: { id: string; app: AppId; request: string; expected: string }[] }).probes
    // a probe is a task with only a request: the label it should get is its expected "verdict" (ui → the main model)
    for (const p of probes) tasks.push({ id: p.id, app: p.app, title: p.id, scenario: 'classifier probe', request: p.request, expected: { verdict: probeVerdict(p.expected) as 'needs-backend', change: probeChanges(p.expected) } } as EvalTask)
  }
  const manifests = loadManifests(tasks)
  const rows: Record<string, unknown>[] = []
  let cost = 0
  // the classifier's prompt cache (stage 5 block 3): input tokens read from the cache, written to it, and uncached
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0 }
  for (const t of tasks) for (let n = 1; n <= repeat; n++) {
    const p = prepareTask(t, manifests[t.app]!)
    const c = await provider.classify({ request: p.request.request, context: classifierContext(p.request, digestsOf(manifests[t.app]!)) }, AbortSignal.timeout(30_000))
    const usd = (c.usage && c.model ? costUsd(c.model, c.usage) : 0) ?? 0
    cost += usd
    if (c.usage) {
      tokens.input += c.usage.inputTokens
      tokens.cacheRead += c.usage.cacheReadTokens
      tokens.cacheWrite += c.usage.cacheWriteTokens
    }
    let before: string | null = null
    if (against) {
      const dir = setDir(against)
      const n = trialsIn(t.id, dir)[0]
      const file = n === undefined ? null : recordingFile(t.id, dir, n)
      const line = file && fs.existsSync(file) ? readTranscript(file).find((l) => l.kind === 'classify') : undefined
      before = line && line.kind === 'classify' ? `${line.output.label}/${line.output.intentLabel ?? ''}` : null
    }
    const now = `${c.label}/${c.intentLabel ?? ''}`
    rows.push({ task: t.id, ...(repeat > 1 ? { n } : {}), expected: t.expected.verdict, before, now, reason: c.reason, ...(c.question ? { question: c.question } : {}) })
    console.log(`${t.id.padEnd(44)} expected ${t.expected.verdict.padEnd(13)} ${before ? `before ${before.padEnd(30)} ` : ''}now ${now}`)
  }
  fs.mkdirSync(RESULTS_DIR, { recursive: true })
  const out = path.join(RESULTS_DIR, `classify-${value('out') ?? against ?? suites.join('-')}.json`)
  // right when the label sends the request where its expected verdict needs it (ok/partial → ui, the others by name)
  const right = rows.filter((r) => classifiedRight(String(r.expected), String(r.now))).length
  const all = tokens.input + tokens.cacheRead + tokens.cacheWrite
  console.log(`right: ${right} of ${rows.length}; classifier input ${all} tokens: cache read ${tokens.cacheRead} (${all ? Math.round((tokens.cacheRead / all) * 1000) / 10 : 0} %), cache write ${tokens.cacheWrite}, uncached ${tokens.input}`)
  fs.writeFileSync(out, JSON.stringify({ promptVersion: PROMPT_VERSION, at: new Date().toISOString(), costUsd: cost, repeat, right, tokens, rows }, null, 2) + '\n')
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
