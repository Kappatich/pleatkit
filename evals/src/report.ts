import { diffBaseline, type DiffStatus } from './baseline.js'
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
const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}
const GRADERS: GraderName[] = ['verdict', 'change', 'check', 'typecheck', 'invariants', 'predicates', 'budget', 'browser']
const STATUS_TEXT: Record<DiffStatus, string> = { pass: 'pass', fail: 'still failing', fixed: 'fixed', regressed: 'REGRESSED', new: 'new task' }

function chip(r: TaskRun, name: GraderName): string {
  const g = r.graders.find((x) => x.grader === name)
  if (!g) return '<td class="g na">·</td>'
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

  const tiles: [string, string, string?][] = [
    ['Pass rate', `${pct(passRate(s))}`, `${passed} of ${s.runs.length} tasks`],
    ['Baseline', pct(d.passRate.baseline), baseline ? `pinned ${baseline.pinnedAt.slice(0, 16).replace('T', ' ')}, prompt ${baseline.promptVersion}` : 'none pinned (pnpm eval:pin)'],
    ['Cost', usd(cost), `${unpriced.length ? `unpriced models: ${unpriced.join(', ')}; ` : ''}cap ${s.budget.capUsd === null ? 'none' : usd(s.budget.capUsd)}`],
    ['Tokens', num(allInput + tokens.output), `in ${num(tokens.input)} · cache read ${num(tokens.cacheRead)} · cache write ${num(tokens.cacheWrite)} · out ${num(tokens.output)}`],
    ['Cache hit rate', allInput ? pct(tokens.cacheRead / allInput) : '—', 'hypothesis H1: ≥ 80 %'],
    ['Model calls', `median ${median(s.runs.filter((r) => r.modelCalls > 0).map((r) => r.modelCalls))}`, `${s.runs.reduce((t, r) => t + r.modelCalls, 0)} in total; H3: median ≤ 3`],
    ['First try', firstTries.length ? pct(firstTries.filter((r) => r.firstTry).length / firstTries.length) : '—', `of ${firstTries.length} runs that wrote files; H2: ≥ 70 %`],
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

  const graderRows = GRADERS.map((g) => {
    const r = rates[g]
    return `<tr><td>${g}</td><td class="n">${r && r.total ? pct(r.pass / r.total) : '—'}</td><td class="n">${r ? `${r.pass} / ${r.total}` : '—'}</td><td class="n">${r ? s.runs.length - r.total : s.runs.length}</td></tr>`
  }).join('')

  const taskRows = s.runs
    .map((r) => {
      const st = d.status[r.taskId]!
      const failed = r.graders.filter((g) => !g.pass)
      const t = r.tokens
      return `<tr class="${r.pass ? '' : 'failrow'}">
<td class="st ${r.pass ? 'ok' : 'bad'}">${r.pass ? 'PASS' : 'FAIL'}</td>
<td><b>${esc(r.taskId)}</b><br><span class="dim">${esc(r.title)}</span></td>
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
<p class="meta">${esc(s.kind)} run of ${s.runs.length} task(s) · started ${esc(s.startedAt)} · report ${esc(at.toISOString())} · browser grader ${s.browser} · tsc grader ${s.typecheck}</p>
<div class="tiles">${tiles.map(([k, v, sub]) => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>`).join('')}</div>
${notes.join('\n')}
<h2>Against the baseline</h2>
${baseline ? `<p>Pass rate ${pct(d.passRate.baseline)} → ${pct(d.passRate.now)}; prompt ${esc(d.prompt.baseline)} → ${esc(d.prompt.now)}; cost ${usd(d.cost.baseline)} → ${usd(d.cost.now)}. Regressed: ${d.regressions.length ? d.regressions.map(esc).join(', ') : 'none'}. Fixed: ${d.fixes.length ? d.fixes.map(esc).join(', ') : 'none'}. New tasks: ${d.added.length ? d.added.map(esc).join(', ') : 'none'}.${d.missing.length ? ` Not in this run: ${d.missing.map(esc).join(', ')}.` : ''}</p>` : '<p>No baseline pinned yet: <code>pnpm eval:pin</code> pins the current results.</p>'}
<h2>Graders</h2>
<div class="wrap"><table><thead><tr><th>Grader</th><th class="n">Pass rate</th><th class="n">Passed</th><th class="n">Not applicable</th></tr></thead><tbody>${graderRows}</tbody></table></div>
<h2>Tasks</h2>
<div class="wrap"><table><thead><tr><th></th><th>Task</th><th>Verdict</th>${GRADERS.map((g) => `<th title="${g}">${g.slice(0, 5)}</th>`).join('')}<th class="n">Calls</th><th class="n">Tokens in / out</th><th class="n">Cost</th><th class="n">ms</th><th>vs baseline</th></tr></thead>
<tbody>
${taskRows}
</tbody></table></div>
<p class="dim">✓ passed · ✗ failed (the reason is under the row; hover a mark for its detail) · – not applicable.</p>
${sanityHtml}
</main></body></html>
`
}
