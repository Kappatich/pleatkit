import fs from 'node:fs'
import path from 'node:path'
import { seriesMetrics } from './metrics.js'
import { setDir } from './tasks.js'
import type { SuiteResult, TaskRun } from './types.js'

/**
 * `pnpm --filter @pleatkit/evals summarize -- <set> [<set> …]`: the numbers of recorded live sets for a report, from
 * their `record.json` (real latencies): per set and per app, pass rate, every-trial tasks, graders, first try, calls,
 * edit latency, cost per edit, cache rate, the parallel classifier's overlap, and the failed runs with reasons.
 */
const sets = process.argv.slice(2).filter((a) => a !== '--')
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)} %` : '—')
const s3 = (ms: number) => `${(ms / 1000).toFixed(1)} s`

function block(label: string, runs: TaskRun[]): string[] {
  const m = seriesMetrics({ runs })
  const cost = runs.reduce((t, r) => t + r.costUsd, 0)
  const graders = Object.entries(m.graders).map(([g, r]) => `${g} ${r.pass}/${r.total}`).join(', ')
  return [
    `## ${label}`,
    `pass ${m.passed}/${m.runs} (${pct(m.passed, m.runs)}); tasks passing every trial ${m.tasksAllPass}/${m.tasks.length}; cost $${cost.toFixed(4)}`,
    `graders: ${graders}`,
    `first try ${m.firstTry.yes}/${m.firstTry.of}; model calls median ${m.modelCalls.median} (runs ${m.modelCalls.runs}, total ${m.modelCalls.total})`,
    `latency all median ${s3(m.latencyMs.median)} p90 ${s3(m.latencyMs.p90)} max ${s3(m.latencyMs.max)}; edits median ${s3(m.editLatencyMs.median)} p95 ${s3(m.editLatencyMs.p95)} (n ${m.editLatencyMs.runs}); classifier-only median ${s3(m.classifierOnlyMs.median)} (n ${m.classifierOnlyMs.runs}); overlap median ${s3(m.overlapMs.median)} (n ${m.overlapMs.runs})`,
    `cost per edit median $${m.costPerEdit.median.toFixed(4)} max $${m.costPerEdit.max.toFixed(4)} (n ${m.costPerEdit.runs}); per request median $${m.costPerRequest.median.toFixed(4)}`,
    `cache all ${m.cacheHitRate === null ? '—' : pct(m.cacheHitRate, 1)}; main ${m.mainCacheHitRate === null ? '—' : pct(m.mainCacheHitRate, 1)}`,
    ...m.tasks.map((t) => `  ${t.passes}/${t.trials} ${t.taskId} [${t.expected}] ${t.verdicts.join(',')} calls ${t.medianCalls} $${t.medianCostUsd.toFixed(4)} ${s3(t.medianMs)}`),
    ...runs.filter((r) => !r.pass).map((r) => `  FAIL ${r.taskId}#${r.trial ?? 1}: ${r.graders.filter((g) => !g.pass).map((g) => `${g.grader}: ${g.reason.split('\n')[0]!.slice(0, 180)}`).join(' | ')}`),
  ]
}

for (const set of sets) {
  const file = path.join(setDir(set), 'record.json')
  if (!fs.existsSync(file)) {
    console.log(`# ${set}: no record.json`)
    continue
  }
  const s = JSON.parse(fs.readFileSync(file, 'utf8')) as SuiteResult
  console.log(`# ${set} (${s.model ?? '?'}, prompt ${s.prompt.version}, ${s.runs.length} runs${s.classifierMode ? ', sequential classifier' : ''})`)
  const apps = [...new Set(s.runs.map((r) => r.app ?? 'demo-crm'))]
  console.log(block('all', s.runs).join('\n'))
  if (apps.length > 1) for (const a of apps) console.log(block(a, s.runs.filter((r) => (r.app ?? 'demo-crm') === a)).join('\n'))
  console.log('')
}
