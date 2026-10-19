import { diffBaseline, type DiffStatus } from './baseline.js'
import { median, seriesMetrics } from './metrics.js'
import { graderRates, passRate } from './runner.js'
import type { Baseline, GraderName, SuiteResult, TaskRun } from './types.js'

export interface SanityResult {
  reference: SuiteResult
  null: SuiteResult
  problems: string[]
}

const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const pct = (x: number | null): string => (x === null ? '—' : `${Math.round(x * 1000) / 10} %`)
const usd = (x: number | null): string => (x === null ? '—' : `$${x.toFixed(x > 0 && x < 0.01 ? 4 : 2)}`)
const num = (x: number): string => x.toLocaleString('en-US')
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`
const GRADERS: GraderName[] = ['verdict', 'change', 'check', 'typecheck', 'invariants', 'predicates', 'budget', 'browser', 'judge']

/** DECISIONS 75 Р3: the judge's "designer would accept" share over the runs it scored. */
export function designerAccepts(runs: Pick<TaskRun, 'judge'>[]): { judged: number; accepted: number; medianScore: number; costUsd: number; criteria: Record<string, number>; preCheckFails: number } {
  const judged = runs.filter((r) => r.judge && r.judge.score > 0)
  const crit = ['design_system', 'no_breakage', 'did_what_asked', 'nothing_unrelated'] as const
  const withCrit = judged.filter((r) => r.judge!.criteria)
  const criteria = Object.fromEntries(crit.map((c) => [c, withCrit.length ? Math.round((median(withCrit.map((r) => r.judge!.criteria![c])) ?? 0) * 10) / 10 : 0]))
  return { judged: judged.length, accepted: judged.filter((r) => r.judge!.accept).length, medianScore: median(judged.map((r) => r.judge!.score)), costUsd: runs.reduce((t, r) => t + (r.judge?.costUsd ?? 0), 0), criteria, preCheckFails: runs.filter((r) => r.judge?.preCheck?.length).length }
}
const acceptText = (a: ReturnType<typeof designerAccepts>): string => (a.judged ? `${a.accepted} / ${a.judged} (${pct(a.accepted / a.judged)})` : '—')
const STATUS_TEXT: Record<DiffStatus, string> = { pass: 'pass', fail: 'still failing', fixed: 'fixed', regressed: 'REGRESSED', new: 'new task' }

function chip(r: TaskRun, name: GraderName): string {
  const g = r.graders.find((x) => x.grader === name)
  if (!g) return '<td class="g na">·</td>'
  // the judge shows its score: 4 and 5 accepted, below that a designer would send it back
  if (name === 'judge' && r.judge) return `<td class="g ${r.judge.accept ? 'ok' : 'bad'}" title="${esc(`judge: ${g.reason}`)}">${r.judge.score || '?'}</td>`
  const cls = g.skipped ? 'skip' : g.pass ? 'ok' : 'bad'
  const mark = g.skipped ? '–' : g.pass ? '✓' : '✗'
  return `<td class="g ${cls}" title="${esc(`${name}: ${g.reason}`)}">${mark}</td>`
}

/** `pnpm eval:report`: one self-contained light HTML page (no scripts, fonts or images from elsewhere). */
export function renderReport(s: SuiteResult, baseline: Baseline | null, sanity: SanityResult | null = null, at = new Date()): string {
  const d = diffBaseline(s, baseline)
  const rates = graderRates(s)
  const tokens = s.runs.reduce((t, r) => ({ input: t.input + r.tokens.input, output: t.output + r.tokens.output, cacheRead: t.cacheRead + r.tokens.cacheRead, cacheWrite: t.cacheWrite + r.tokens.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  const allInput = tokens.input + tokens.cacheRead + tokens.cacheWrite
  const cost = s.runs.reduce((t, r) => t + r.costUsd, 0)
  // scripted fixtures are models named `scripted:<fixture>`: one entry per kind, not per fixture
  const unpriced = [...new Set(s.runs.flatMap((r) => r.unpricedModels.map((m) => m.split(':')[0]!)))]
  const firstTries = s.runs.filter((r) => r.firstTry !== null)
  const recordedWith = [...new Set(s.runs.map((r) => r.recording?.promptVersion).filter((v): v is string => Boolean(v)))]
  const passed = s.runs.filter((r) => r.pass).length
  const m = seriesMetrics(s)
  const trials = s.runs.some((r) => r.trial !== undefined)
  const unit = trials ? 'runs' : 'tasks'
  const label = (r: TaskRun) => (r.trial === undefined ? r.taskId : `${r.taskId} #${r.trial}`)
  // cacheHitRate() over the agent's usage rows; results written before they were kept fall back to the token totals
  const hit = m.cacheHitRate ?? (allInput ? tokens.cacheRead / allInput : null)

  const tiles: [string, string, string?][] = [
    ['Pass rate', `${pct(passRate(s))}`, `${passed} of ${s.runs.length} ${unit}${trials ? `; ${m.tasksAllPass} of ${m.tasks.length} tasks pass every trial` : ''}`],
    ['Baseline', pct(d.passRate.baseline), baseline ? `pinned ${baseline.pinnedAt.slice(0, 16).replace('T', ' ')}, prompt ${baseline.promptVersion}` : 'none pinned (pnpm eval:pin)'],
    ['Cost', usd(cost), `${unpriced.length ? `unpriced models: ${unpriced.join(', ')}; ` : ''}cap ${s.budget.capUsd === null ? 'none' : usd(s.budget.capUsd)}`],
    ['Tokens', num(allInput + tokens.output), `in ${num(tokens.input)} · cache read ${num(tokens.cacheRead)} · cache write ${num(tokens.cacheWrite)} · out ${num(tokens.output)}`],
    ['Cache hit rate', pct(hit), `cacheHitRate() over every call${m.mainCacheHitRate !== null ? `; main model only ${pct(m.mainCacheHitRate)}` : ''}; H1: ≥ 80 %`],
    ['Cost per edit', m.costPerEdit.runs ? `median $${m.costPerEdit.median.toFixed(4)}` : '—', `max $${m.costPerEdit.max.toFixed(4)} over ${m.costPerEdit.runs} runs that changed files; per request median ${usd(m.costPerRequest.median)}; H4: ≤ $0.10`],
    ['Latency', `median ${secs(m.latencyMs.median)}`, `p90 ${secs(m.latencyMs.p90)}, max ${secs(m.latencyMs.max)}${s.kind === 'replay' ? ' (replay: not model latency)' : ''}; H5: p95 ≤ 45 s`],
    ['Edit latency', m.editLatencyMs.runs ? `median ${secs(m.editLatencyMs.median)}` : '—', `p95 ${secs(m.editLatencyMs.p95)} over ${m.editLatencyMs.runs} runs that changed files; answered by the classifier alone: median ${secs(m.classifierOnlyMs.median)} (${m.classifierOnlyMs.runs})${m.overlapMs.runs ? `; parallel start saved median ${secs(m.overlapMs.median)} (${m.overlapMs.runs} runs)` : ''}`],
    ['Model calls', `median ${median(s.runs.filter((r) => r.modelCalls > 0).map((r) => r.modelCalls))}`, `${s.runs.reduce((t, r) => t + r.modelCalls, 0)} in total; H3: median ≤ 3`],
    ['First try', firstTries.length ? pct(firstTries.filter((r) => r.firstTry).length / firstTries.length) : '—', `of ${firstTries.length} runs that wrote files; H2: ≥ 70 %`],
    ...(s.runs.some((r) => r.judge) ? (() => { const a = designerAccepts(s.runs); const crit = Object.entries(a.criteria).map(([k, v]) => `${k.split('_').map((w) => w[0]).join('')} ${v}`).join(' · '); return [['Designer would accept', acceptText(a), `overall ≥ 4 over the runs that changed files; median overall ${a.medianScore}; per-criterion medians ${crit}; ${a.preCheckFails} failed a pre-check; judging cost ${usd(a.costUsd)}, not in the cost above`] as [string, string, string]] })() : []),
    ['Prompt', s.prompt.version, `prefix ≈ ${num(s.prompt.prefixTokens)} tokens${d.prompt.prefixTokensBaseline !== null && d.prompt.prefixTokensBaseline !== s.prompt.prefixTokens ? ` (baseline ${num(d.prompt.prefixTokensBaseline)}, ${s.prompt.prefixTokens > d.prompt.prefixTokensBaseline ? '+' : ''}${num(s.prompt.prefixTokens - d.prompt.prefixTokensBaseline)})` : ''}`],
  ]

  const notes: string[] = []
  if (s.aborted) notes.push(`<p class="alert">Run stopped: ${esc(s.aborted.reason)}</p>`)
  if (d.regressions.length) notes.push(`<p class="alert">Regressions against the baseline: ${d.regressions.map(esc).join(', ')}</p>`)
  if (recordedWith.some((v) => v !== s.prompt.version))
    notes.push(`<p class="note">Transcripts were recorded with prompt ${recordedWith.map(esc).join(', ')}; the current prompt is ${esc(s.prompt.version)}. A replay repeats the recorded answers, so it measures the harness, the tools and the graders, not the new prompt: re-record with a model (stage 5) to measure a prompt change.</p>`)
  if (unpriced.length) notes.push(`<p class="note">${cost === 0 ? 'Cost is $0 because the answers come' : 'Part of the answers come'} from models without a price (${unpriced.map(esc).join(', ')}): scripted or replayed runs. The accounting is the same path a live run uses.</p>`)
  if (s.browser === 'skipped') notes.push('<p class="note">The browser grader did not run (--no-browser).</p>')
  if (s.typecheck === 'skipped') notes.push('<p class="note">The tsc grader did not run (PLEATKIT_TYPECHECK_ROOT empty).</p>')

  // stage 5 block 2: the foreign apps next to the demo, one row per app
  const apps = [...new Set(s.runs.map((r) => r.app ?? 'demo-crm'))]
  const appRows = apps
    .map((a) => {
      const runs = s.runs.filter((r) => (r.app ?? 'demo-crm') === a)
      const am = seriesMetrics({ runs })
      const prefix = s.prompt.byApp?.[a as keyof NonNullable<typeof s.prompt.byApp>]?.prefixTokens ?? (apps.length === 1 ? s.prompt.prefixTokens : null)
      return `<tr><td><b>${esc(a)}</b></td><td class="n">${am.passed} / ${am.runs} (${pct(am.runs ? am.passed / am.runs : 0)})</td><td class="n">${am.tasksAllPass} / ${am.tasks.length}</td><td class="n">${am.firstTry.of ? `${am.firstTry.yes} / ${am.firstTry.of}` : '—'}</td><td class="n">${am.modelCalls.median}</td><td class="n">${am.costPerEdit.runs ? `$${am.costPerEdit.median.toFixed(4)}` : '—'}</td><td class="n">${am.editLatencyMs.runs ? secs(am.editLatencyMs.median) : '—'}</td><td class="n">${pct(am.mainCacheHitRate)}</td><td class="n">${prefix === null ? '—' : '≈ ' + num(prefix)}</td><td class="n">${acceptText(designerAccepts(runs))}</td></tr>`
    })
    .join('')

  const graderRows = GRADERS.map((g) => {
    const r = rates[g]
    return `<tr><td>${g}</td><td class="n">${r && r.total ? pct(r.pass / r.total) : '—'}</td><td class="n">${r ? `${r.pass} / ${r.total}` : '—'}</td><td class="n">${r ? s.runs.length - r.total : s.runs.length}</td></tr>`
  }).join('')

  const trialRows = m.tasks
    .map((t) => `<tr><td class="st ${t.passes === t.trials ? 'ok' : t.passes ? '' : 'bad'}">${t.passes} / ${t.trials}</td><td><b>${esc(t.taskId)}</b><br><span class="dim">${esc(t.title)}</span></td><td>${esc(t.expected)}</td><td>${t.verdicts.map((v) => (v === t.expected ? esc(v) : `<b class="badtext">${esc(v)}</b>`)).join(', ')}</td><td class="n">${t.medianCalls}</td><td class="n">${usd(t.medianCostUsd)}</td><td class="n">${secs(t.medianMs)}</td><td class="${d.status[t.taskId] === 'regressed' ? 'badtext' : d.status[t.taskId] === 'fixed' ? 'oktext' : 'dim'}">${STATUS_TEXT[d.status[t.taskId]!]}</td></tr>`)
    .join('\n')

  const taskRows = s.runs
    .map((r) => {
      const st = d.status[r.taskId]!
      const failed = r.graders.filter((g) => !g.pass)
      const t = r.tokens
      return `<tr class="${r.pass ? '' : 'failrow'}">
<td class="st ${r.pass ? 'ok' : 'bad'}">${r.pass ? 'PASS' : 'FAIL'}</td>
<td><b>${esc(label(r))}</b><br><span class="dim">${esc(r.title)}</span></td>
<td>${esc(r.expectedVerdict)}${r.verdict !== r.expectedVerdict ? ` → <b class="badtext">${esc(r.verdict)}</b>` : ''}</td>
${GRADERS.map((g) => chip(r, g)).join('')}
<td class="n">${r.modelCalls}</td><td class="n">${num(t.input + t.cacheRead + t.cacheWrite)} / ${num(t.output)}</td><td class="n">${usd(r.costUsd)}</td><td class="n">${num(r.ms)}</td>
<td class="${st === 'regressed' ? 'badtext' : st === 'fixed' ? 'oktext' : 'dim'}">${STATUS_TEXT[st]}</td>
</tr>${failed.length ? `<tr class="why"><td></td><td colspan="${GRADERS.length + 8}">${failed.map((g) => `<div><b>${g.grader}</b>: ${esc(g.reason)}</div>`).join('')}${r.error ? `<div><b>error</b>: ${esc(r.error)}</div>` : ''}</td></tr>` : ''}`
    })
    .join('\n')

  let sanityHtml = ''
  if (sanity) {
    const refPass = sanity.reference.runs.filter((r) => r.pass).length
    const nullFail = sanity.null.runs.filter((r) => !r.pass).length
    sanityHtml = `<h2>Sanity check</h2>
<p>Reference solutions: <b>${refPass} of ${sanity.reference.runs.length}</b> pass every grader. Null agent (writes nothing, finishes at once with the expected verdict): fails <b>${nullFail} of ${sanity.null.runs.length}</b> tasks; it must fail every task that requires a change and may pass the ones where doing nothing is the right answer.</p>
${sanity.problems.length ? `<p class="alert">${sanity.problems.map(esc).join('<br>')}</p>` : '<p class="oktext">Sanity holds.</p>'}`
  }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>pleatkit eval report</title>
<style>
:root{color-scheme:light}
body{margin:0;background:#fff;color:#111;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:1280px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;border-bottom:2px solid #111;padding-bottom:4px}
.dim{color:#666}.meta{color:#555;margin:0 0 16px}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}
.tile{border:1px solid #ddd;padding:10px 12px}.tile .k{font-size:12px;color:#666;text-transform:uppercase;letter-spacing:.04em}.tile .v{font-size:20px;font-weight:600;margin:2px 0}.tile .s{font-size:12px;color:#555}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e5e5e5;padding:6px 8px;text-align:left;vertical-align:top}
th{font-size:12px;color:#555;border-bottom:2px solid #111;white-space:nowrap}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td.g{text-align:center;width:28px;font-weight:700}.g.ok{color:#137333}.g.bad{color:#c5221f;background:#fdecea}.g.skip,.g.na{color:#aaa}
.st{font-weight:700;font-size:12px}.st.ok,.oktext{color:#137333}.st.bad,.badtext{color:#c5221f}
tr.why td{border-bottom:1px solid #e5e5e5;background:#fafafa;font-size:12px;color:#333;padding-top:2px}
.alert{border-left:4px solid #c5221f;background:#fdecea;padding:8px 12px}.note{border-left:4px solid #999;background:#f6f6f6;padding:8px 12px}
.wrap{overflow-x:auto}
</style></head>
<body><main>
<h1>pleatkit eval report</h1>
<p class="meta">${esc(s.kind)} run${s.set ? ` of the set ${esc(s.set)}` : ''} of ${s.runs.length} ${unit}${s.model ? ` · model ${esc(s.model)}` : ''}${s.classifier === false ? ' · classifier off' : ''} · started ${esc(s.startedAt)} · report ${esc(at.toISOString())} · browser grader ${s.browser} · tsc grader ${s.typecheck}</p>
<div class="tiles">${tiles.map(([k, v, sub]) => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>`).join('')}</div>
${notes.join('\n')}
<h2>Against the baseline</h2>
${baseline ? `<p>Pass rate ${pct(d.passRate.baseline)} → ${pct(d.passRate.now)}; prompt ${esc(d.prompt.baseline)} → ${esc(d.prompt.now)}; cost ${usd(d.cost.baseline)} → ${usd(d.cost.now)}. Regressed: ${d.regressions.length ? d.regressions.map(esc).join(', ') : 'none'}. Fixed: ${d.fixes.length ? d.fixes.map(esc).join(', ') : 'none'}. New tasks: ${d.added.length ? d.added.map(esc).join(', ') : 'none'}.${d.missing.length ? ` Not in this run: ${d.missing.map(esc).join(', ')}.` : ''}</p>` : '<p>No baseline pinned yet: <code>pnpm eval:pin</code> pins the current results.</p>'}
${apps.length > 1 || apps[0] !== 'demo-crm' ? `<h2>By app</h2>
<div class="wrap"><table><thead><tr><th>App</th><th class="n">Passed</th><th class="n">Tasks, every trial</th><th class="n">First try</th><th class="n">Calls (median)</th><th class="n">Cost per edit (median)</th><th class="n">Edit latency (median)</th><th class="n">Cache, main model</th><th class="n">Prefix tokens</th><th class="n">Designer would accept</th></tr></thead><tbody>${appRows}</tbody></table></div>` : ''}
<h2>Graders</h2>
<div class="wrap"><table><thead><tr><th>Grader</th><th class="n">Pass rate</th><th class="n">Passed</th><th class="n">Not applicable</th></tr></thead><tbody>${graderRows}</tbody></table></div>
${trials ? `<h2>Tasks across trials</h2>
<div class="wrap"><table><thead><tr><th>Passed</th><th>Task</th><th>Expected</th><th>Verdicts</th><th class="n">Calls (median)</th><th class="n">Cost (median)</th><th class="n">Time (median)</th><th>vs baseline</th></tr></thead>
<tbody>
${trialRows}
</tbody></table></div>` : ''}
<h2>${trials ? 'Runs' : 'Tasks'}</h2>
<div class="wrap"><table><thead><tr><th></th><th>Task</th><th>Verdict</th>${GRADERS.map((g) => `<th title="${g}">${g.slice(0, 5)}</th>`).join('')}<th class="n">Calls</th><th class="n">Tokens in / out</th><th class="n">Cost</th><th class="n">ms</th><th>vs baseline</th></tr></thead>
<tbody>
${taskRows}
</tbody></table></div>
<p class="dim">✓ passed · ✗ failed (the reason is under the row; hover a mark for its detail) · – not applicable. The judge column is the visual-quality score (1–5; 4 or more: a designer would accept it); it is advisory and does not decide pass or fail.</p>
${sanityHtml}
</main></body></html>
`
}
