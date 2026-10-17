// Smoke test for `pnpm dev`: start everything on spare ports, check that the four servers answer through the
// Vite proxy (including one scripted agent run over SSE), then shut down the same way Ctrl+C does and verify
// that every process we started is gone and the ports are free. Opens no windows.
import { spawn, execFileSync } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ports = { WEB_PORT: '5199', DATA_PORT: '8791', AGENT_PORT: '8792', STORE_PORT: '8793' }
const web = `http://localhost:${ports.WEB_PORT}`

const child = spawn(process.execPath, [path.join(root, 'apps', 'demo-crm', 'scripts', 'dev.mjs')], {
  cwd: path.join(root, 'apps', 'demo-crm'),
  env: { ...process.env, ...ports, MORPHKIT_STORE_DB: ':memory:', MORPHKIT_PROVIDER: 'scripted', PATH: `${path.join(root, 'apps', 'demo-crm', 'node_modules', '.bin')}${path.delimiter}${process.env.PATH}` },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
})
let output = ''
child.stdout.on('data', (d) => (output += d))
child.stderr.on('data', (d) => (output += d))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(url, ms = 60_000) {
  const until = Date.now() + ms
  for (;;) {
    try {
      const res = await fetch(url)
      if (res.ok) return res
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error(`timeout waiting for ${url}\n${output}`)
    await sleep(300)
  }
}

function descendants(pid) {
  if (process.platform !== 'win32') return []
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], { encoding: 'utf8' })
  const rows = JSON.parse(out)
  const all = new Set([pid])
  let grew = true
  while (grew) {
    grew = false
    for (const r of rows) {
      if (all.has(r.ParentProcessId) && !all.has(r.ProcessId)) {
        all.add(r.ProcessId)
        grew = true
      }
    }
  }
  all.delete(pid)
  return [...all]
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const portFree = (port) =>
  new Promise((resolve) => {
    const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)))
    s.listen(Number(port))
  })

let failed = false
try {
  const started = Date.now()
  await waitFor(`${web}/`)
  await waitFor(`${web}/api/health`)
  const agent = await (await waitFor(`${web}/agent/health`)).json()
  await waitFor(`${web}/morphkit-store/health`)
  console.log(`[dev-smoke] all four servers up through the Vite proxy in ${Date.now() - started} ms (agent provider: ${agent.provider})`)

  const manifest = await (await fetch(`${web}/morphkit.manifest.json`)).json()
  const files = Object.fromEntries(manifest.dynamic.map((f) => [f.path, f.source]))
  const res = await fetch(`${web}/agent/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      userId: 'alice',
      appId: 'dev-smoke',
      request: 'In the customer card add phone, city and source',
      files,
      readonly: Object.fromEntries(manifest.readonly.map((f) => [f.path, f.source])),
      coreTypes: Object.fromEntries(manifest.coreTypes.map((f) => [f.path, f.source])),
      context: { dynamicRoots: manifest.dynamicRoots, externals: manifest.externals, externalPatterns: manifest.externalPatterns, alias: manifest.alias },
      components: manifest.dynamic.map((f) => f.path),
    }),
  })
  const sse = await res.text()
  const result = JSON.parse(/event: result\ndata: (.*)/.exec(sse)?.[1] ?? 'null')
  if (result?.verdict !== 'ok' || !result.requestId) throw new Error(`agent run through the dev proxy failed:\n${sse.slice(-800)}`)
  console.log(`[dev-smoke] scripted agent run over SSE through the proxy: ${result.verdict}, ${Object.keys(result.files).length} file(s), logged as ${result.requestId}`)
} catch (e) {
  failed = true
  console.error(`[dev-smoke] ${e.message}`)
} finally {
  const tree = descendants(child.pid)
  const stopped = new Promise((r) => child.once('exit', r))
  child.send('shutdown')
  await Promise.race([stopped, sleep(15_000)])
  await sleep(1_000)
  const left = tree.filter(alive)
  const busy = []
  for (const [name, port] of Object.entries(ports)) if (!(await portFree(port))) busy.push(`${name}=${port}`)
  console.log(`[dev-smoke] shutdown: dev process exited=${child.exitCode !== null}, ${tree.length} child processes started, ${left.length} left, busy ports: ${busy.join(', ') || 'none'}`)
  if (left.length || busy.length || child.exitCode === null) {
    failed = true
    for (const pid of left) {
      try {
        process.kill(pid)
      } catch {
        // already gone
      }
    }
  }
  process.exit(failed ? 1 : 0)
}
