import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from 'vite'

// The real host build bundles React from the app; here only the plugin's wiring is under test.
vi.mock('../src/isolated.js', () => ({ buildIsolatedHost: vi.fn(async () => 'console.log("isolated host")') }))

const { default: morphkit, isolatedCorsMiddleware, ISOLATED_DEV_PATH, ISOLATED_FILE_PREFIX } = await import('../src/index.js')

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture')
const options = {
  zones: { dynamic: ['src/dynamic/**'], readonly: ['src/readonly/**', 'src/components/ui/**'] },
  externals: ['@/components/ui/*', '@/lib/utils', '@/readonly/*'],
  isolated: true,
}

type Hook = (this: unknown, ...args: unknown[]) => unknown
function plugin(command: 'build' | 'serve') {
  const p = morphkit(options)
  ;(p.configResolved as Hook)({ root, command, base: '/', build: { assetsDir: 'assets' }, logger: { warn: () => undefined } } as unknown as ResolvedConfig)
  const emitted: { fileName: string; source: string }[] = []
  const load = async (id: string) => {
    const resolved = (p.resolveId as Hook)(id) as string
    return (await (p.load as Hook).call({ emitFile: (f: { fileName: string; source: string }) => emitted.push(f) }, resolved)) as string
  }
  return { p, load, emitted }
}

describe('isolated host as a separate file (DECISIONS 16)', () => {
  it('build: emits the host as an asset and the virtual module only carries its URL (nothing to inline)', async () => {
    const { load, emitted } = plugin('build')
    const code = await load('virtual:morphkit/isolated')
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.fileName).toMatch(new RegExp(`^assets/${ISOLATED_FILE_PREFIX}[0-9a-f]{10}\\.js$`))
    expect(emitted[0]!.source).toBe('console.log("isolated host")')
    expect(code).toBe(`export default { url: ${JSON.stringify('/' + emitted[0]!.fileName)} }`)
    expect(code).not.toContain('isolated host')
  })

  it('dev: points at the dev-server route that serves the host with CORS', async () => {
    const { load } = plugin('serve')
    expect(await load('virtual:morphkit/isolated')).toBe(`export default { url: "/${ISOLATED_DEV_PATH}" }`)
  })

  it('preview middleware adds Access-Control-Allow-Origin to the host file only (the frame has Origin: null)', () => {
    const mw = isolatedCorsMiddleware()
    const run = (url: string) => {
      const headers: Record<string, string> = {}
      const next = vi.fn()
      mw({ url } as never, { setHeader: (k: string, v: string) => (headers[k] = v) } as never, next)
      expect(next).toHaveBeenCalled()
      return headers
    }
    expect(run(`/assets/${ISOLATED_FILE_PREFIX}0123456789.js`)['Access-Control-Allow-Origin']).toBe('*')
    expect(run('/assets/index-abc.js')['Access-Control-Allow-Origin']).toBeUndefined()
  })
})
