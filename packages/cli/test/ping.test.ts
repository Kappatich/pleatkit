import { describe, expect, it } from 'vitest'
import { ping } from '../src/ping.js'

const manifest = {
  dynamicRoots: ['src/dynamic/'],
  dynamic: [{ path: 'src/dynamic/card.tsx', source: 'export default () => null' }],
  readonly: [],
  coreTypes: [],
  externals: ['react'],
  externalPatterns: ['react'],
  alias: { '@': 'src' },
}
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } })
const html = () => new Response('<!doctype html><div id="root"></div>', { headers: { 'content-type': 'text/html' } })

function server(routes: Record<string, () => Response>, seen: { url: string; body?: unknown }[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    seen.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    const path = new URL(url).pathname
    return (routes[path] ?? html)()
  }) as typeof fetch
}

describe('morphkit ping', () => {
  it('manifest, agent health and one SSE run through the app origin', async () => {
    const seen: { url: string; body?: unknown }[] = []
    const sse = 'event: progress\ndata: {"type":"status","text":"Understanding the request"}\n\nevent: result\ndata: {"verdict":"ok","summary":"Nothing to change."}\n\n'
    const r = await ping(
      'http://app.test/',
      server(
        {
          '/morphkit.manifest.json': () => json(manifest),
          '/agent/health': () => json({ ok: true, provider: 'scripted', model: 'scripted' }),
          '/agent/run': () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
        },
        seen,
      ),
    )
    expect(r.ok).toBe(true)
    expect(r.lines).toEqual([
      '[ok]   manifest: 1 dynamic, 0 readonly files',
      '[ok]   agent: provider scripted, model scripted',
      '[ok]   agent run over SSE: 1 progress line(s), verdict ok',
      '       summary: Nothing to change.',
    ])
    const run = seen.find((s) => s.url.endsWith('/agent/run'))!.body as { components: string[]; files: Record<string, string> }
    expect(run.components).toEqual(['src/dynamic/card.tsx'])
    expect(Object.keys(run.files)).toEqual(['src/dynamic/card.tsx'])
  })

  it('a dev server answering index.html for /agent/health means the proxy is missing', async () => {
    const r = await ping('http://app.test', server({ '/morphkit.manifest.json': () => json(manifest) }))
    expect(r.ok).toBe(false)
    expect(r.lines.at(-1)).toMatch(/\[FAIL\] .*agent\/health answered HTML \(no proxy\).*server\.proxy/)
  })

  it('no manifest: the app is not running with the plugin', async () => {
    const r = await ping('http://app.test', server({}))
    expect(r.lines.at(-1)).toMatch(/\[FAIL\] .*morphkit\.manifest\.json answered HTML/)
  })
})
