// Run TASKS stage 2 item 6: scenario 1 through the real Anthropic provider, without a browser.
// Prints progress, timings, token usage and the estimated cost, and writes docs/metrics-anthropic.json.
//
//   PowerShell:  $env:MORPHKIT_API_KEY = '<key>'; pnpm agent:live
//   bash:        MORPHKIT_API_KEY=<key> pnpm agent:live
//
// Optional: MORPHKIT_MODEL, MORPHKIT_CLASSIFIER_MODEL, MORPHKIT_EFFORT, MORPHKIT_BASE_URL, MORPHKIT_FALLBACKS=off.
// A custom request: pnpm agent:live "Show deals sorted by amount"
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const key = process.env.MORPHKIT_API_KEY ?? process.env.POLYMORPH_API_KEY ?? process.env.ANTHROPIC_API_KEY
if (!key) {
  console.error('Set MORPHKIT_API_KEY (or ANTHROPIC_API_KEY) first. Nothing was sent.')
  process.exit(2)
}
const manifestPath = path.join(root, 'apps', 'demo-crm', 'dist', 'morphkit.manifest.json')
if (!fs.existsSync(manifestPath)) {
  console.error('Build first: pnpm build')
  process.exit(2)
}
const { configFromEnv, runAgent } = await import(new URL('../packages/agent/dist/index.js', import.meta.url).href)
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const text = process.argv[2] ?? 'In the customer card add phone, city and source; highlight an overdue payment date in red'
const request = {
  userId: 'alice',
  appId: 'live',
  request: text,
  files: Object.fromEntries(manifest.dynamic.map((f) => [f.path, f.source])),
  readonly: Object.fromEntries(manifest.readonly.map((f) => [f.path, f.source])),
  coreTypes: Object.fromEntries(manifest.coreTypes.map((f) => [f.path, f.source])),
  context: { dynamicRoots: manifest.dynamicRoots, externals: manifest.externals, externalPatterns: manifest.externalPatterns, alias: manifest.alias },
  components: manifest.dynamic.filter((f) => /\.(tsx|ts)$/.test(f.path)).map((f) => f.path),
}
const { provider } = configFromEnv({ ...process.env, MORPHKIT_PROVIDER: 'anthropic', MORPHKIT_API_KEY: key })
console.log(`provider ${provider.name}, model ${provider.model}, classifier ${provider.classifierModel}`)
console.log(`request: ${text}\n`)
const t0 = Date.now()
const result = await runAgent(request, provider, { onProgress: (p) => console.log(`  ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s  ${p.text}`) })
const cost = result.usage.reduce((s, u) => s + (u.costUsd ?? 0), 0)
console.log(`\nverdict ${result.verdict}${result.stopReason ? ` (${result.stopReason})` : ''}: ${result.summary}`)
console.log(`files changed: ${Object.keys(result.files).join(', ') || 'none'}`)
console.log(`time: total ${result.timings.totalMs} ms, classifier ${result.timings.classifyMs} ms, model ${result.timings.modelMs} ms, tools ${result.timings.toolsMs} ms, ${result.modelCalls} model calls`)
for (const u of result.usage) {
  console.log(`usage ${u.model}: ${u.calls} calls, in ${u.inputTokens}, out ${u.outputTokens}, cache read ${u.cacheReadTokens}, cache write ${u.cacheWriteTokens}, $${(u.costUsd ?? 0).toFixed(5)}`)
}
console.log(`estimated cost: $${cost.toFixed(5)}`)
const out = { measuredAt: new Date().toISOString(), request: text, verdict: result.verdict, stopReason: result.stopReason ?? null, timings: result.timings, modelCalls: result.modelCalls, usage: result.usage, costUsd: cost, toolCalls: result.log.map((l) => `${l.tool}${l.ok ? '' : ' (error)'}`) }
fs.writeFileSync(path.join(root, 'docs', 'metrics-anthropic.json'), JSON.stringify(out, null, 2) + '\n')
for (const [p, src] of Object.entries(result.files)) fs.writeFileSync(path.join(root, 'docs', `anthropic-result-${path.basename(p)}.txt`), src)
process.exit(result.verdict === 'ok' ? 0 : 1)
