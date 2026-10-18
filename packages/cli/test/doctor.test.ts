import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { buildManifest } from '@pleatkit/vite-plugin'
import { checkCsp, checkExternals, checkPanels, checkReact, checkSecrets, cspProblems, doctor, formatFindings } from '../src/doctor.js'

const dirs: string[] = []
function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pleatkit-doctor-'))
  dirs.push(root)
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  return root
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const options = { zones: { dynamic: ['src/dynamic/**'], readonly: ['src/readonly/**'] }, externals: ['@/readonly/*', '@/lib/utils'] }
const pkg = (name: string, version = '19.1.0') => JSON.stringify({ name, version, main: 'index.js' })

describe('pleatkit doctor', () => {
  it('panels: every <Dynamic id> needs a file in the dynamic zone with a default export', () => {
    const root = project({
      'src/App.tsx': `export const App = () => <><Dynamic id="card" props={{}} /><Dynamic id='missing' /><Dynamic id={"table"} /></>`,
      'src/dynamic/card.tsx': `export function Card() { return null }`,
      'src/dynamic/table.tsx': `const T = () => null\nexport { T as default }`,
    })
    const f = checkPanels(root, buildManifest(root, options))
    expect(f.status).toBe('fail')
    expect(f.details).toEqual([
      'src/dynamic/card.tsx has no default export (mounted as <Dynamic id="card"> in src/App.tsx)',
      '<Dynamic id="missing"> in src/App.tsx: no file src/dynamic/missing.tsx in the dynamic zone',
    ])
    expect(f.fix).toContain('export default')
  })

  it('externals: aliases must point at files, packages must be installed', () => {
    const root = project({
      'src/dynamic/a.tsx': 'export default () => null',
      'src/lib/utils.ts': 'export const cn = () => ""',
      'src/readonly/api.ts': 'export {}',
      'node_modules/react/package.json': pkg('react'),
      'node_modules/react-dom/package.json': pkg('react-dom'),
    })
    const manifest = buildManifest(root, { ...options, externals: [...options.externals, 'left-pad', '@/lib/missing'] })
    const f = checkExternals(root, manifest)
    expect(f.status).toBe('fail')
    expect(f.details).toEqual(['left-pad (package not installed)', '@/lib/missing → src/lib/missing (no such file)'])
  })

  it('csp: blob: and wasm-unsafe-eval are required; no policy at all is fine', () => {
    expect(cspProblems("default-src 'self'")).toEqual([
      'script-src needs blob: (edits load as blob: modules)',
      "script-src needs 'wasm-unsafe-eval' (the compiler is WebAssembly)",
      'worker-src needs blob:',
    ])
    expect(cspProblems("script-src 'self' blob: 'wasm-unsafe-eval'; worker-src blob:")).toEqual([])
    // compile: 'server' (the default) needs neither blob: nor WebAssembly
    expect(cspProblems("default-src 'self'", 'server')).toEqual([])
    expect(cspProblems("script-src https://cdn.test", 'server')).toHaveLength(1)
    const strict = project({ 'index.html': `<meta http-equiv="Content-Security-Policy" content="script-src 'self'; worker-src 'self'">` })
    expect(checkCsp(strict, false, 'browser')).toMatchObject({ status: 'fail' })
    expect(checkCsp(strict, false)).toMatchObject({ status: 'ok' })
    expect(checkCsp(project({ 'index.html': '<html></html>' }), true)).toMatchObject({ status: 'ok' })
  })

  it('secrets: keys in the bundle and VITE_ secrets fail, and the report never prints the key', () => {
    const key = 'sk-ant-api03-' + 'A1b2C3d4E5'.repeat(4)
    const root = project({ 'dist/assets/index-abc.js': `const k="${key}";fetch("/x")`, '.env': 'VITE_ANTHROPIC_API_KEY=abc\nPLEATKIT_API_KEY=fine-on-the-server\n', '.env.example': 'VITE_X_KEY=placeholder' })
    const f = checkSecrets(root, path.join(root, 'dist'))
    expect(f.status).toBe('fail')
    expect(f.details).toHaveLength(2)
    expect(f.details.join('\n')).toContain('VITE_ANTHROPIC_API_KEY')
    expect(f.details.join('\n')).toContain('Anthropic API key sk-ant-…')
    expect(formatFindings([f], root)).not.toContain(key)
    expect(checkSecrets(project({}), '/nonexistent-dist')).toMatchObject({ status: 'warn' })
  })

  it('react: two copies fail unless Vite dedupes them', () => {
    const root = project({
      'package.json': pkg('app', '0.0.0'),
      'node_modules/react/package.json': pkg('react'),
      'node_modules/react-dom/package.json': pkg('react-dom'),
      'node_modules/@pleatkit/runtime/package.json': pkg('@pleatkit/runtime', '0.1.0'),
      'node_modules/@pleatkit/runtime/node_modules/react/package.json': pkg('react'),
    })
    const dup = checkReact(root, [])
    expect(dup.status).toBe('fail')
    expect(dup.fix).toContain("dedupe: ['react', 'react-dom']")
    expect(checkReact(root, ['react', 'react-dom']).status).toBe('warn')
    expect(checkReact(project({ 'package.json': pkg('app') }), []).status).toBe('fail')
  })

  it('passes on the demo app (loads its real vite.config)', async () => {
    const demo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../apps/demo-crm')
    const findings = await doctor({ root: demo })
    expect(findings.map((f) => f.id)).toEqual(['config', 'react', 'panels', 'externals', 'context-budget', 'csp', 'secure-context', 'secrets'])
    expect(findings.filter((f) => f.status === 'fail')).toEqual([])
    expect(findings.find((f) => f.id === 'panels')?.details).toContain('<Dynamic id="customer-card">')
  }, 60_000)

  it('reports a missing plugin with the fix', async () => {
    const root = project({ 'vite.config.mjs': 'export default { plugins: [] }', 'package.json': pkg('app', '0.0.0') })
    const findings = await doctor({ root })
    expect(findings[0]).toMatchObject({ id: 'config', status: 'fail' })
    expect(formatFindings(findings, root)).toMatch(/\[FAIL\] config: no pleatkit plugin/)
  }, 60_000)
})

describe('secure context (code review 06 item 4)', () => {
  it('warns on plain http off localhost, fails with signed bundles, passes on https and localhost', async () => {
    const { checkSecureContext } = await import('../src/doctor.js')
    expect(checkSecureContext('https://crm.example', undefined, true).status).toBe('ok')
    expect(checkSecureContext('http://localhost:5173', undefined, true).status).toBe('ok')
    expect(checkSecureContext('http://intranet.corp:8080', undefined, false).status).toBe('warn')
    expect(checkSecureContext('http://intranet.corp:8080', undefined, true).status).toBe('fail')
    expect(checkSecureContext(undefined, { host: true, https: false }, false).status).toBe('warn')
    expect(checkSecureContext(undefined, { host: undefined, https: false }, false).status).toBe('ok')
  })
})

describe('context budget (brainstorm 04 §8 item 12)', () => {
  it('estimates the cached prefix and the tail and warns over the targets', async () => {
    const { checkContextBudget } = await import('../src/doctor.js')
    const m = (readonly: number, dynamic: number) => ({ version: 1 as const, dynamicRoots: ['src/dynamic/'], dynamic: [{ path: 'src/dynamic/a.tsx', source: 'x'.repeat(dynamic) }], readonly: [{ path: 'src/readonly/api.ts', source: 'x'.repeat(readonly) }], coreTypes: [], externals: [], externalPatterns: [], alias: {} })
    expect(checkContextBudget(m(7_000, 3_500)).status).toBe('ok')
    expect(checkContextBudget(m(70_000, 3_500))).toMatchObject({ status: 'warn', details: expect.arrayContaining([expect.stringContaining('largest in the prefix: src/readonly/api.ts')]) })
    expect(checkContextBudget(m(7_000, 35_000)).status).toBe('warn')
  })
})
