import fs from 'node:fs'
import path from 'node:path'
import type { TokenUsage } from '@pleatkit/runtime/compiler'
import { buildPrompt, configFromEnv, costUsd, PROMPT_VERSION, runAgent, TOOLS } from '@pleatkit/agent'
import { digestsOf } from './runner.js'
import { loadManifests, loadSuites, prepareTask, RESULTS_DIR, type Suite } from './tasks.js'

/**
 * `pnpm eval:cancel -- --tasks all`: what the parallel classifier's cancelled early call costs (DECISIONS 74.1).
 * For every task the classifier answers alone (needs-backend, a question, off-topic, declined):
 *
 * - after: the request as the agent server runs it (classifier and streamed early call together); the early call is
 *   cancelled when the classifier answers, and `cancelledCall` says what its stream had reported (`message_start`:
 *   input and cache tokens; output seen so far) and how long it had been generating;
 * - before: the same first main-model call without streaming and without a cancel, run to its end: the API reports no
 *   usage for a cancelled plain request, so a full first turn is the most it could have billed (block 2's estimate).
 *
 * Needs PLEATKIT_API_KEY and spends a few cents per task (the full turns); `--only` picks tasks, `--skip-before` runs
 * only the streamed side. Writes evals/results/cancel-probe.json.
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const value = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined)
  const tasksArg = value('tasks') ?? 'all'
  const suites = (tasksArg === 'all' ? ['demo', 'apps'] : tasksArg.split(',')) as Suite[]
  if (!process.env.PLEATKIT_API_KEY) {
    console.error('eval:cancel calls the models: set PLEATKIT_API_KEY')
    return 2
  }
  const provider = configFromEnv(process.env).provider
  const answeredAlone = new Set(['needs-backend', 'clarify', 'refused', 'declined'])
  const tasks = loadSuites(suites, value('only')?.split(',')).filter((t) => !t.target && !t.clarification && !t.migration && answeredAlone.has(t.expected.verdict))
  const manifests = loadManifests(tasks)
  const rows: Record<string, unknown>[] = []
  let spent = 0
  const price = (model: string, u: TokenUsage) => costUsd(model, u) ?? 0
  for (const t of tasks) {
    const m = manifests[t.app]!
    const p = prepareTask(t, m)
    const digests = digestsOf(m)
    // after: as the server runs it
    const r = await runAgent(p.request, provider, { protected: p.trusted.protected, base: p.trusted.base, digests })
    const runCost = r.usage.reduce((s, u) => s + (u.costUsd ?? 0), 0)
    spent += runCost
    const c = r.cancelledCall
    const after = c ? price(c.model, c.usage) : 0
    // before: the same first call, plain and to its end
    let before: { usd: number; usage: TokenUsage; ms: number; ttftUnknown: true } | null = null
    if (!args.includes('--skip-before')) {
      const started = performance.now()
      const turn = await provider.start(buildPrompt(p.request, undefined, digests), TOOLS, { request: p.request.request }).next([], { signal: AbortSignal.timeout(90_000), maxOutputTokens: 8_000 })
      const usd = price(turn.model, turn.usage)
      spent += usd
      before = { usd, usage: turn.usage, ms: Math.round(performance.now() - started), ttftUnknown: true }
    }
    rows.push({ task: t.id, app: t.app, verdict: r.verdict, classifyMs: r.timings.classifyMs === null ? null : Math.round(r.timings.classifyMs), cancelled: c ?? null, afterUsd: after, before })
    console.log(
      `${t.id.padEnd(40)} ${r.verdict.padEnd(13)} cancelled ${c ? (c.started ? `after ${c.ms} ms (${c.generatingMs} ms generating): in ${c.usage.inputTokens} + cache ${c.usage.cacheReadTokens}r/${c.usage.cacheWriteTokens}w, out ≥ ${c.usage.outputTokens}, $${after.toFixed(4)}` : `after ${c.ms} ms, before message_start`) : 'no'}` +
        (before ? ` | full first turn: in ${before.usage.inputTokens} + cache ${before.usage.cacheReadTokens}r/${before.usage.cacheWriteTokens}w, out ${before.usage.outputTokens}, ${before.ms} ms, $${before.usd.toFixed(4)}` : ''),
    )
  }
  fs.mkdirSync(RESULTS_DIR, { recursive: true })
  const out = path.join(RESULTS_DIR, 'cancel-probe.json')
  fs.writeFileSync(out, JSON.stringify({ promptVersion: PROMPT_VERSION, model: provider.model, at: new Date().toISOString(), spentUsd: spent, rows }, null, 2) + '\n')
  console.log(`${rows.length} tasks, prompt ${PROMPT_VERSION}, spent $${spent.toFixed(4)}; ${path.relative(process.cwd(), out)}`)
  return 0
}

main().then(
  (code) => process.exit(code),
  (e: Error) => {
    console.error(e.message)
    process.exit(1)
  },
)
