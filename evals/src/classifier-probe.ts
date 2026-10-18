import fs from 'node:fs'
import path from 'node:path'
import { classifierContext, configFromEnv, costUsd, PROMPT_VERSION, readTranscript } from '@pleatkit/agent'
import { digestsOf } from './runner.js'
import { loadManifests, loadSuites, prepareTask, RESULTS_DIR, setDir, type Suite } from './tasks.js'
import { recordingFile, trialsIn } from './providers.js'

/**
 * `pnpm eval:classify -- --tasks apps --against <set>`: the classifier alone on every task it would see (no target,
 * no clarification), with today's prompt and the app's data contract, next to the label the set recorded. A
 * classifier change measured for the price of the small model (a few hundredths of a dollar), before any edit runs.
 * Needs PLEATKIT_API_KEY; writes evals/results/classify-<set>.json.
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
  const tasks = loadSuites(suites, value('only')?.split(',')).filter((t) => !t.target && !t.clarification && !t.migration)
  const manifests = loadManifests(tasks)
  const rows: Record<string, unknown>[] = []
  let cost = 0
  for (const t of tasks) {
    const p = prepareTask(t, manifests[t.app]!)
    const c = await provider.classify({ request: p.request.request, context: classifierContext(p.request, digestsOf(manifests[t.app]!)) }, AbortSignal.timeout(30_000))
    const usd = (c.usage && c.model ? costUsd(c.model, c.usage) : 0) ?? 0
    cost += usd
    let before: string | null = null
    if (against) {
      const dir = setDir(against)
      const n = trialsIn(t.id, dir)[0]
      const file = n === undefined ? null : recordingFile(t.id, dir, n)
      const line = file && fs.existsSync(file) ? readTranscript(file).find((l) => l.kind === 'classify') : undefined
      before = line && line.kind === 'classify' ? `${line.output.label}/${line.output.intentLabel ?? ''}` : null
    }
    const now = `${c.label}/${c.intentLabel ?? ''}`
    rows.push({ task: t.id, expected: t.expected.verdict, before, now, reason: c.reason, ...(c.question ? { question: c.question } : {}) })
    console.log(`${t.id.padEnd(44)} expected ${t.expected.verdict.padEnd(13)} ${before ? `before ${before.padEnd(30)} ` : ''}now ${now}`)
  }
  fs.mkdirSync(RESULTS_DIR, { recursive: true })
  const out = path.join(RESULTS_DIR, `classify-${against ?? suites.join('-')}.json`)
  fs.writeFileSync(out, JSON.stringify({ promptVersion: PROMPT_VERSION, at: new Date().toISOString(), costUsd: cost, rows }, null, 2) + '\n')
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
