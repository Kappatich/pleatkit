/**
 * `pleatkit ping`: checks the running app end to end, the way the browser talks to it: the manifest the Vite
 * plugin serves, the agent behind the app's `/agent` proxy, and one agent run over SSE. With a real model the
 * run costs one small request (the agent is asked to change nothing); with the scripted provider it is free.
 */
export interface PingResult {
  ok: boolean
  lines: string[]
}

interface ManifestFile {
  path: string
  source: string
}
interface Manifest {
  dynamicRoots: string[]
  dynamic: ManifestFile[]
  readonly: ManifestFile[]
  coreTypes: ManifestFile[]
  externals: string[]
  externalPatterns: string[]
  alias: Record<string, string>
}

/** Dev servers answer unknown paths with index.html (SPA fallback): 200, but not what was asked for. */
const isJson = (res: Response) => (res.headers.get('content-type') ?? '').includes('json')

const map = (files: ManifestFile[]) => Object.fromEntries(files.map((f) => [f.path, f.source]))

export async function ping(url: string, fetchFn: typeof fetch = fetch): Promise<PingResult> {
  const base = url.replace(/\/$/, '')
  const lines: string[] = []
  const fail = (line: string): PingResult => ({ ok: false, lines: [...lines, `[FAIL] ${line}`] })

  let manifest: Manifest
  try {
    const res = await fetchFn(`${base}/pleatkit.manifest.json`)
    if (!res.ok || !isJson(res)) {
      return fail(`${base}/pleatkit.manifest.json answered ${res.ok ? 'HTML' : res.status}: is the app running (vite dev, or vite preview after vite build) with the pleatkit plugin?`)
    }
    manifest = (await res.json()) as Manifest
    lines.push(`[ok]   manifest: ${manifest.dynamic.length} dynamic, ${manifest.readonly.length} readonly files`)
  } catch (e) {
    return fail(`cannot reach ${base}: ${(e as Error).message}`)
  }

  try {
    const res = await fetchFn(`${base}/agent/health`)
    if (!res.ok || !isJson(res)) return fail(`${base}/agent/health answered ${res.ok ? 'HTML (no proxy)' : res.status}: add server.proxy (and preview.proxy) { '/agent': 'http://localhost:8789' } to vite.config and start the agent server (npx pleatkit-agent)`)
    const health = (await res.json()) as { provider: string; model: string }
    lines.push(`[ok]   agent: provider ${health.provider}, model ${health.model}`)
  } catch (e) {
    return fail(`agent health check failed: ${(e as Error).message}`)
  }

  const components = manifest.dynamic.filter((f) => /\.(tsx|jsx|ts|js)$/.test(f.path) && /export\s+default\b/.test(f.source)).map((f) => f.path)
  const body = {
    userId: 'pleatkit-ping',
    appId: 'pleatkit-ping',
    request: 'pleatkit ping: this is a connectivity test. Do not change anything; call finish with verdict "ok".',
    files: map(manifest.dynamic),
    readonly: map(manifest.readonly),
    coreTypes: map(manifest.coreTypes),
    context: { dynamicRoots: manifest.dynamicRoots, externals: manifest.externals, externalPatterns: manifest.externalPatterns, alias: manifest.alias },
    components,
  }
  const res = await fetchFn(`${base}/agent/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok || !res.body) return fail(`POST ${base}/agent/run answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const text = await res.text()
  const events = [...text.matchAll(/event: (\w+)\r?\ndata: (.*)/g)].map((m) => ({ event: m[1]!, data: JSON.parse(m[2]!) as Record<string, unknown> }))
  const progress = events.filter((e) => e.event === 'progress').map((e) => String(e.data.text))
  const result = events.find((e) => e.event === 'result')?.data
  if (!result) return fail(`no result event from the agent (${events.map((e) => e.event).join(', ') || 'empty stream'})`)
  lines.push(`[ok]   agent run over SSE: ${progress.length} progress line(s), verdict ${String(result.verdict)}`)
  lines.push(`       summary: ${String(result.summary)}`)
  return { ok: true, lines }
}
