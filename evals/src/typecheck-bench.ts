import { createTypechecker, warmTypecheck } from '@pleatkit/agent'
import { APPS, isAppId } from './apps.js'
import { loadManifests, loadSuites, prepareTask } from './tasks.js'

/**
 * Stage 5 block 5 (brainstorm 17 §4): how long the agent's type check of one edit takes on an app, cold (a fresh
 * checker, as after a restart) and warm (the same checker, the next edits), with the checker the agent server uses.
 * Free: no model. `pnpm --filter @pleatkit/evals exec tsx src/typecheck-bench.ts shadcn-admin [rounds]`.
 */
async function main(): Promise<void> {
  const app = process.argv[2] ?? 'shadcn-admin'
  if (!isAppId(app)) throw new Error(`unknown app ${app}`)
  const rounds = Number(process.argv[3] ?? 5)
  const tasks = loadSuites(['apps', 'demo']).filter((t) => t.app === app && t.reference && t.expected.change)
  const manifests = loadManifests(tasks)
  const tc = createTypechecker({ root: APPS[app].dir, warm: process.env.PLEATKIT_TYPECHECK_WARM !== '0' })
  const times: number[] = []
  if (process.env.BENCH_WARMUP === '1') {
    const p0 = prepareTask(tasks[0]!, manifests[app]!)
    const ms = await warmTypecheck(tc, { files: p0.trusted.base, readonly: p0.request.readonly, coreTypes: p0.request.coreTypes, context: p0.request.context, components: p0.request.components })
    console.log(`warm-up ${Math.round(ms)} ms`)
  }
  for (let i = 0; i < rounds; i++) {
    const t = tasks[i % tasks.length]!
    const p = prepareTask(t, manifests[app]!)
    // the edit: one changed line in the task's target panel (or its first file), so the affected set is one panel
    const files = { ...p.request.files }
    // every panel file in turn (the heavy ones are the tables with TanStack Table's types and the recharts chart)
    const panels = Object.keys(files).filter((f) => f.endsWith('.tsx')).sort()
    const file = panels[i % panels.length]!
    files[file] = `const __bench${i} = ${i}\nvoid __bench${i}\n` + files[file]!
    const started = performance.now()
    const errors = await tc(files, { files, readonly: p.request.readonly, coreTypes: p.request.coreTypes, context: p.request.context, components: p.request.components, base: p.trusted.base })
    const ms = performance.now() - started
    times.push(ms)
    console.log(`${i === 0 ? 'cold' : 'warm'} ${t.id.padEnd(40)} ${file.padEnd(40)} ${Math.round(ms)} ms, ${errors.length} errors`)
  }
  const warm = times.slice(1).sort((a, b) => a - b)
  console.log(`cold ${Math.round(times[0]!)} ms; warm median ${Math.round(warm[Math.floor(warm.length / 2)] ?? 0)} ms, max ${Math.round(warm[warm.length - 1] ?? 0)} ms`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
