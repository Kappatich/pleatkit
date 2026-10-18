// One `check` for the browser and the agent server (code review 06, item 12): static rules (V1 A2, brainstorm
// 05 #1 and 04 §7), protected elements (05 #20) and the default-export rule, over the same AST in both places.
//
// TypeScript is stripped by esbuild (`transform`, JSX preserved): native esbuild on the server, esbuild-wasm in
// the browser. The result is parsed with acorn + acorn-jsx, and positions are mapped back to the source through
// esbuild's source map, so an error points at the line the model (or the developer) wrote.

import { Parser, type Node as AcornNode } from 'acorn'
import jsx from 'acorn-jsx'
import { matchesExternal } from './vfs.js'
import { dirnameOf, normalizePath } from './paths.js'
import type { CompileError, FileMap } from './types.js'

export type StaticRule =
  | 'no-eval'
  | 'no-function-constructor'
  | 'no-string-timer'
  | 'no-document-cookie'
  | 'no-raw-html'
  | 'no-remote-request'
  | 'no-computed-url'
  | 'no-remote-css'
  | 'no-global-css'
  | 'no-xhr'
  | 'no-worker'
  | 'no-storage'
  | 'no-navigation'
  | 'no-cross-window'
  | 'no-computed-global'
  | 'no-global-alias'
  | 'no-constructor-access'
  | 'no-dynamic-import'
  | 'allowed-imports'
  | 'protected-element'
  | 'default-export'

/** What the rules need to know about the app. On the agent server it comes from the server's own manifest. */
export interface CheckContext {
  externals: string[]
  externalPatterns: string[]
  dynamicRoots: string[]
  /** Selectors of elements an edit must keep and must not hide (`[data-consent]`, `.legal`, `#terms`). */
  protected?: string[]
  /** The release's original dynamic files: protected elements are counted there. */
  base?: FileMap
}

/** The esbuild call the check needs (native esbuild and esbuild-wasm both have it). */
export type TransformFn = (
  source: string,
  options: { loader: 'tsx' | 'ts' | 'jsx' | 'js'; jsx: 'preserve'; sourcemap: 'external'; format: 'esm'; target: string; sourcefile: string },
) => Promise<{ code: string; map: string }>

const SCRIPT = /\.(tsx|ts|jsx|js|mts|mjs)$/
const JsxParser = Parser.extend(jsx())

interface N {
  type: string
  start: number
  end: number
  loc?: { start: { line: number; column: number } }
  [key: string]: unknown
}

const isNode = (v: unknown): v is N => typeof v === 'object' && v !== null && typeof (v as N).type === 'string'

/** Every node with its parent, depth first. */
function walk(root: N, visit: (node: N, parent: N | null) => void): void {
  const stack: [N, N | null][] = [[root, null]]
  while (stack.length) {
    const [node, parent] = stack.pop()!
    visit(node, parent)
    const children: N[] = []
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue
      const v = node[key]
      if (Array.isArray(v)) {
        for (const x of v) if (isNode(x)) children.push(x)
      }
      else if (isNode(v)) children.push(v)
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push([children[i]!, node])
  }
}

// --- source maps (esbuild's, to map generated positions back to the file as written) ---

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** `mappings` of a v3 source map → per generated line, segments [genCol, srcLine, srcCol] (0-based). */
export function decodeMappings(mappings: string): number[][][] {
  const lines: number[][][] = []
  let srcLine = 0
  let srcCol = 0
  for (const line of mappings.split(';')) {
    const segs: number[][] = []
    let genCol = 0
    for (const seg of line.split(',')) {
      if (!seg) continue
      const values: number[] = []
      let value = 0
      let shift = 0
      for (const ch of seg) {
        const digit = B64.indexOf(ch)
        value += (digit & 31) << shift
        if (digit & 32) shift += 5
        else {
          values.push(value & 1 ? -(value >>> 1) : value >>> 1)
          value = 0
          shift = 0
        }
      }
      genCol += values[0] ?? 0
      if (values.length >= 4) {
        srcLine += values[2]!
        srcCol += values[3]!
        segs.push([genCol, srcLine, srcCol])
      }
    }
    lines.push(segs)
  }
  return lines
}

function mapper(map: string | null): (line: number, column: number) => { line: number; column: number } {
  let decoded: number[][][] | null = null
  try {
    decoded = map ? decodeMappings((JSON.parse(map) as { mappings: string }).mappings) : null
  } catch {
    decoded = null
  }
  return (line, column) => {
    if (!decoded) return { line, column: column + 1 }
    for (let l = line - 1; l >= 0; l--) {
      const segs = decoded[l]
      if (!segs || segs.length === 0) continue
      let best = segs[0]!
      for (const s of segs) if (s[0]! <= (l === line - 1 ? column : Infinity)) best = s
      return { line: best[1]! + 1, column: (l === line - 1 ? best[2]! : 0) + 1 }
    }
    return { line, column: column + 1 }
  }
}

// --- URLs ---

/**
 * An absolute URL, a protocol-relative one, or one browsers read as protocol-relative (`/\host`, `\\host`).
 * Browsers skip leading whitespace and control characters in URLs, so the rules do too.
 */
// eslint-disable-next-line no-control-regex
const ABSOLUTE_URL = /^[\s\u0000-\u001f]*([a-z][a-z0-9+.-]*:|\/\/|\/\\|\\)/i
// eslint-disable-next-line no-control-regex
const JS_URL = /^[\s\u0000-\u001f]*j[\s\u0000-\u001f]*a[\s\u0000-\u001f]*v[\s\u0000-\u001f]*a[\s\u0000-\u001f]*s[\s\u0000-\u001f]*c[\s\u0000-\u001f]*r[\s\u0000-\u001f]*i[\s\u0000-\u001f]*p[\s\u0000-\u001f]*t[\s\u0000-\u001f]*:/i
/** A computed URL is fine when its fixed start already pins it to this origin: `/customers/${id}`, `./x`, `?q=`, `#a`. */
const PINNED_PREFIX = /^(\/[^/\\\s]|\.\.?\/|\?|#)/
const MAIL = /^(mailto|tel):/i
/** Element properties and attributes that make the browser load or navigate to a URL. */
const URL_ATTRS = new Set(['src', 'href', 'action', 'formaction', 'srcset', 'poster', 'data', 'ping', 'background', 'xlink:href', 'xlinkhref', 'cite', 'codebase', 'manifest', 'imagesrcset'])
const BANNED_TAGS = new Set(['script', 'style', 'object', 'embed', 'base', 'meta', 'applet', 'frame', 'frameset', 'portal'])
const BANNED_CREATE = new Set(['script', 'style', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'frame', 'img', 'image', 'audio', 'video', 'source', 'form'])
const CSS_URL = /url\(\s*(['"]?)\s*(?!data:)([a-z][a-z0-9+.-]*:|\/\/|\/\\|\\)/i
const CSS_URL_OPEN = /url\(\s*['"]?\s*$/i

// --- globals ---

const WINDOWS = new Set(['window', 'globalThis', 'self'])
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self', 'document', 'navigator', 'location'])
const STORAGE = new Set(['localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookieStore'])
const CROSS_WINDOW = new Set(['top', 'parent', 'opener', 'frames'])
const WORKERS = new Set(['Worker', 'SharedWorker', 'importScripts', 'ServiceWorker'])
const WATCHED = new Set([
  ...GLOBAL_OBJECTS,
  ...STORAGE,
  ...CROSS_WINDOW,
  ...WORKERS,
  'eval',
  'Function',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Image',
  'Audio',
  'open',
  'setTimeout',
  'setInterval',
])

const HINT = {
  network: 'talk to the server only through the typed client in the readonly zone, or fetch("/relative/url")',
  url: 'use a relative URL written in the code ("/customers/" + id is fine, a URL from data or an absolute one is not)',
  css: 'use colors, gradients or images that ship with the app; no absolute or computed url()',
}

interface Report {
  (node: N, rule: StaticRule, text: string): void
}

/** Names declared anywhere in the file (variables, parameters, functions, classes, imports, catch clauses). */
function declaredNames(ast: N): Set<string> {
  const out = new Set<string>()
  const pattern = (p: unknown): void => {
    if (!isNode(p)) return
    if (p.type === 'Identifier') out.add(p.name as string)
    else if (p.type === 'ObjectPattern') for (const prop of p.properties as N[]) pattern(prop.type === 'RestElement' ? prop.argument : prop.value)
    else if (p.type === 'ArrayPattern') for (const el of p.elements as N[]) pattern(el)
    else if (p.type === 'RestElement') pattern(p.argument)
    else if (p.type === 'AssignmentPattern') pattern(p.left)
  }
  walk(ast, (n) => {
    if (n.type === 'VariableDeclarator') pattern(n.id)
    else if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'ClassDeclaration' || n.type === 'ClassExpression') {
      if (n.id) pattern(n.id)
      for (const p of (n.params as N[] | undefined) ?? []) pattern(p)
    } else if (n.type === 'CatchClause') pattern(n.param)
    else if (n.type === 'ImportSpecifier' || n.type === 'ImportDefaultSpecifier' || n.type === 'ImportNamespaceSpecifier') pattern(n.local)
  })
  return out
}

/** Is this identifier a read of a variable (not a property name, a declaration or a label)? */
function isReference(id: N, parent: N | null): boolean {
  if (!parent) return true
  switch (parent.type) {
    case 'MemberExpression':
      return parent.object === id || Boolean(parent.computed)
    case 'Property':
      if (parent.key === id && !parent.computed) return Boolean(parent.shorthand) && parent.value === id
      return true
    case 'MethodDefinition':
    case 'PropertyDefinition':
      return parent.key !== id || Boolean(parent.computed)
    case 'VariableDeclarator':
      return parent.init === id
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
    case 'ClassDeclaration':
    case 'ClassExpression':
      return parent.body === id
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier':
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'MetaProperty':
    case 'CatchClause':
      return false
    case 'AssignmentPattern':
      return parent.right === id
    case 'ArrayPattern':
    case 'ObjectPattern':
    case 'RestElement':
      return false
    default:
      return true
  }
}

const literalText = (n: unknown): string | null => (isNode(n) && n.type === 'Literal' && typeof n.value === 'string' ? (n.value as string) : null)

/** `"..."`, `` `...${x}` `` (its fixed start), `"a" + x` (its leftmost literal), else null. */
function urlParts(n: N): { text: string; computed: boolean } | null {
  if (n.type === 'Literal' && typeof n.value === 'string') return { text: n.value as string, computed: false }
  if (n.type === 'TemplateLiteral') {
    const quasis = n.quasis as N[]
    const head = ((quasis[0]?.value as { cooked?: string } | undefined)?.cooked ?? '') as string
    return { text: head, computed: (n.expressions as N[]).length > 0 }
  }
  if (n.type === 'BinaryExpression' && n.operator === '+') {
    const left = urlParts(n.left as N)
    return left ? { text: left.text, computed: true } : null
  }
  return null
}

/** A URL the browser will load or navigate to: relative and written in the code, or the edit is refused. */
function checkUrl(report: Report, node: N, value: N | undefined | null, what: string, opts: { allowMail?: boolean } = {}): void {
  if (!value) return
  if (value.type === 'Identifier' && value.name === 'undefined') return
  if (value.type === 'Literal' && (value.value === null || value.value === undefined)) return
  if (value.type === 'ConditionalExpression') {
    checkUrl(report, node, value.consequent as N, what, opts)
    checkUrl(report, node, value.alternate as N, what, opts)
    return
  }
  if (value.type === 'JSXExpressionContainer') return checkUrl(report, node, value.expression as N, what, opts)
  if (value.type === 'JSXEmptyExpression') return
  const parts = urlParts(value)
  if (!parts) return report(node, 'no-computed-url', `${what} with a URL computed at run time is not allowed: ${HINT.url}`)
  if (JS_URL.test(parts.text)) return report(node, 'no-computed-url', `${what} with a javascript: URL is not allowed`)
  if (opts.allowMail && MAIL.test(parts.text)) return
  if (ABSOLUTE_URL.test(parts.text)) return report(node, 'no-remote-request', `${what} to "${parts.text.slice(0, 80)}" is not allowed: only relative URLs of this app (${HINT.url})`)
  if (parts.computed && !PINNED_PREFIX.test(parts.text)) {
    return report(node, 'no-computed-url', `${what} starts with a computed part, so it could point to another site: ${HINT.url}`)
  }
}

function checkCssText(report: Report, node: N, text: string, followedByExpression: boolean): void {
  if (CSS_URL.test(text)) report(node, 'no-remote-css', `url() to another site is not allowed in styles: ${HINT.css}`)
  else if (followedByExpression && CSS_URL_OPEN.test(text)) report(node, 'no-remote-css', `url() with a computed address is not allowed in styles: ${HINT.css}`)
  else if (/url\(/i.test(text) && JS_URL.test(text.replace(/^.*url\(\s*['"]?/is, ''))) report(node, 'no-remote-css', 'javascript: URLs are not allowed in styles')
}

// --- protected elements (brainstorm 05 #20) ---

interface ProtectedSel {
  raw: string
  kind: 'attr' | 'class' | 'id'
  name: string
  value?: string
}

export function parseProtected(selectors: string[] = []): ProtectedSel[] {
  const out: ProtectedSel[] = []
  for (const raw of selectors) {
    const s = raw.trim()
    let m: RegExpExecArray | null
    if ((m = /^\[\s*([\w:-]+)\s*(?:=\s*["']?([^"'\]]*)["']?\s*)?\]$/.exec(s))) out.push({ raw: s, kind: 'attr', name: m[1]!, ...(m[2] !== undefined ? { value: m[2] } : {}) })
    else if ((m = /^\.([\w-]+)$/.exec(s))) out.push({ raw: s, kind: 'class', name: m[1]! })
    else if ((m = /^#([\w-]+)$/.exec(s))) out.push({ raw: s, kind: 'id', name: m[1]! })
  }
  return out
}

function attrName(a: N): string {
  const name = a.name as N
  return name.type === 'JSXNamespacedName' ? `${(name.namespace as N).name}:${(name.name as N).name}` : (name.name as string)
}

function attrLiteral(a: N): string | null {
  const v = a.value as N | null
  if (!v) return ''
  if (v.type === 'Literal' && typeof v.value === 'string') return v.value as string
  if (v.type === 'JSXExpressionContainer') {
    const e = v.expression as N
    if (e.type === 'Literal' && typeof e.value === 'string') return e.value as string
    if (e.type === 'TemplateLiteral' && (e.expressions as N[]).length === 0) return ((e.quasis as N[])[0]!.value as { cooked: string }).cooked
  }
  return null
}

/** Does this JSX opening element match a protected selector? Class names are matched in any string of className. */
function matchesProtected(el: N, sel: ProtectedSel): boolean {
  for (const a of el.attributes as N[]) {
    if (a.type !== 'JSXAttribute') continue
    const name = attrName(a)
    if (sel.kind === 'attr' && name === sel.name) return sel.value === undefined || attrLiteral(a) === sel.value
    if (sel.kind === 'id' && name === 'id' && attrLiteral(a) === sel.name) return true
    if (sel.kind === 'class' && (name === 'className' || name === 'class')) {
      let hit = false
      walk(a, (n) => {
        const t = literalText(n) ?? (n.type === 'TemplateElement' ? (n.value as { cooked: string }).cooked : null)
        if (t && t.split(/\s+/).includes(sel.name)) hit = true
      })
      if (hit) return true
    }
  }
  return false
}

const HIDING_CLASS = /(^|\s)(hidden|invisible|sr-only|opacity-0|collapse|h-0|w-0|max-h-0|scale-0|-z-\d+|display-none)(\s|$)/
const HIDING_STYLE = /^(display|visibility|opacity|height|width|maxHeight|maxWidth|transform|clip|clipPath|zIndex|pointerEvents|fontSize)$/

function hidesElement(el: N): string | null {
  for (const a of el.attributes as N[]) {
    if (a.type !== 'JSXAttribute') continue
    const name = attrName(a)
    if (name === 'hidden' || name === 'inert') return `the "${name}" attribute`
    if (name === 'aria-hidden' && attrLiteral(a) !== 'false') return 'aria-hidden'
    if (name === 'className' || name === 'class') {
      let found: string | null = null
      walk(a, (n) => {
        const t = literalText(n) ?? (n.type === 'TemplateElement' ? (n.value as { cooked: string }).cooked : null)
        if (t && HIDING_CLASS.test(t)) found = `the class "${t.match(HIDING_CLASS)![2]}"`
      })
      if (found) return found
    }
    if (name === 'style') {
      const v = a.value as N | null
      const e = v?.type === 'JSXExpressionContainer' ? (v.expression as N) : null
      if (!e || e.type !== 'ObjectExpression') return 'a computed style'
      for (const p of e.properties as N[]) {
        const key = p.type === 'Property' ? ((p.key as N).name ?? (p.key as N).value) : null
        if (typeof key === 'string' && HIDING_STYLE.test(key)) return `the style "${key}"`
        if (p.type === 'SpreadElement') return 'a spread style'
      }
    }
  }
  return null
}

function countProtected(ast: N, sels: ProtectedSel[]): Map<string, number> {
  const counts = new Map<string, number>()
  walk(ast, (n) => {
    if (n.type !== 'JSXOpeningElement') return
    for (const s of sels) if (matchesProtected(n, s)) counts.set(s.raw, (counts.get(s.raw) ?? 0) + 1)
  })
  return counts
}

// --- one file ---

interface Parsed {
  ast: N
  at: (n: N) => { line: number; column: number }
}

async function parseFile(path: string, source: string, transform: TransformFn): Promise<Parsed | null> {
  const loader = path.endsWith('.tsx') ? 'tsx' : path.endsWith('.jsx') ? 'jsx' : path.endsWith('.ts') || path.endsWith('.mts') ? 'ts' : 'js'
  let code: string
  let map: string | null = null
  try {
    const out = await transform(source, { loader, jsx: 'preserve', sourcemap: 'external', format: 'esm', target: 'esnext', sourcefile: path })
    code = out.code
    map = out.map
  } catch {
    // a syntax error: the compile step reports it with a position
    return null
  }
  let ast: N
  try {
    ast = JsxParser.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true }) as unknown as N
  } catch {
    return null
  }
  const toSource = mapper(map)
  return { ast, at: (n) => (n.loc ? toSource(n.loc.start.line, n.loc.start.column) : { line: 1, column: 1 }) }
}

function rulesForFile(path: string, parsed: Parsed, ctx: CheckContext, push: (e: CompileError) => void, protectedBase: Map<string, number> | null, sels: ProtectedSel[]): void {
  const { ast, at } = parsed
  const report: Report = (node, rule, text) => {
    const { line, column } = at(node)
    push({ file: path, line, column, text: `${text} [${rule}]`, rule })
  }
  const declared = declaredNames(ast)
  const parents = new Map<N, N | null>()
  walk(ast, (n, p) => parents.set(n, p))
  const parentOf = (n: N) => parents.get(n) ?? null

  const checkSpecifier = (node: N, spec: string) => {
    if (ABSOLUTE_URL.test(spec)) return report(node, 'no-dynamic-import', `Importing code from a URL ("${spec}") is not allowed`)
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const target = normalizePath(dirnameOf(path) + '/' + spec)
      if (!ctx.dynamicRoots.some((r) => target.startsWith(r.replace(/\/$/, '') + '/') || target === r.replace(/\/$/, ''))) {
        report(node, 'allowed-imports', `"${spec}" points outside the dynamic zone; import shared code through the allowed modules (${ctx.externalPatterns.join(', ')})`)
      }
      return
    }
    if (!matchesExternal(spec, ctx)) report(node, 'allowed-imports', `"${spec}" is not an allowed module; dynamic code may import only ${ctx.externalPatterns.join(', ')} and other dynamic files`)
  }

  /** A use of a watched global: `window.document.cookie`, `fetch(...)`, `localStorage.x`, `location.href = ...`. */
  const onGlobal = (id: N) => {
    let top = id
    const names: string[] = [id.name as string]
    let computed = false
    for (;;) {
      const p = parentOf(top)
      if (!p || p.type !== 'MemberExpression' || p.object !== top) break
      if (p.computed) {
        const lit = literalText(p.property)
        if (lit === null) {
          computed = true
          break
        }
        names.push(lit)
      } else names.push((p.property as N).name as string)
      top = p
    }
    const root = names[0]!
    while (names.length > 1 && WINDOWS.has(names[0]!)) names.shift()
    const ctxNode = parentOf(top)
    const role =
      ctxNode?.type === 'CallExpression' && ctxNode.callee === top
        ? 'call'
        : ctxNode?.type === 'NewExpression' && ctxNode.callee === top
          ? 'new'
          : (ctxNode?.type === 'AssignmentExpression' && ctxNode.left === top) || ctxNode?.type === 'UpdateExpression'
            ? 'assign'
            : ctxNode?.type === 'UnaryExpression' && ctxNode.operator === 'typeof'
              ? 'typeof'
              : 'value'
    const args = (ctxNode?.arguments as N[] | undefined) ?? []
    if (computed && GLOBAL_OBJECTS.has(names[0]!)) {
      return report(top, 'no-computed-global', `Computed property access on ${names.join('.')} is not allowed; write the property name out`)
    }
    if (role === 'typeof') return
    const [a, b] = names
    switch (a) {
      case 'window':
      case 'globalThis':
      case 'self':
        if (computed) return report(top, 'no-computed-global', `Computed property access on ${root} is not allowed; write the property name out`)
        return report(top, 'no-global-alias', `${root} cannot be passed around or aliased`)
      case 'eval':
        return report(top, 'no-eval', role === 'call' ? 'eval() is not allowed' : 'eval cannot be used as a value')
      case 'Function':
        return report(top, 'no-function-constructor', role === 'call' || role === 'new' ? 'Function() is not allowed' : 'Function cannot be used as a value')
      case 'setTimeout':
      case 'setInterval':
        if (role === 'call' && args[0] && urlParts(args[0]) !== null) report(top, 'no-string-timer', `${a} with a string of code is not allowed; pass a function`)
        return
      case 'fetch':
        if (role === 'call' && names.length === 1) return checkUrl(report, top, args[0], 'fetch')
        return report(top, 'no-remote-request', `fetch may only be called directly, with a relative URL: ${HINT.network}`)
      case 'XMLHttpRequest':
        return report(top, 'no-xhr', `XMLHttpRequest is not allowed: ${HINT.network}`)
      case 'WebSocket':
      case 'EventSource':
        if (role === 'new' && names.length === 1) return checkUrl(report, top, args[0], a)
        return report(top, 'no-remote-request', `${a} may only be created directly, with a relative URL`)
      case 'Image':
      case 'Audio':
        return report(top, 'no-remote-request', `new ${a}() is not allowed; render <img> or <audio> in JSX with a relative src`)
      case 'open':
        return report(top, 'no-navigation', 'window.open is not allowed; use a link with a relative href')
      case 'document':
        if (names.length === 1) return report(top, 'no-global-alias', 'document cannot be passed around or aliased; use document.<property> directly')
        if (b === 'cookie') return report(top, 'no-document-cookie', 'document.cookie is not allowed')
        if (b === 'write' || b === 'writeln') return report(top, 'no-raw-html', 'document.write is not allowed; render with JSX')
        if (b === 'domain') return report(top, 'no-global-alias', 'document.domain is not allowed')
        if (b === 'location') return onLocation(top, names.slice(1), role)
        if (b === 'createElement' && role === 'call') {
          const tag = literalText(args[0])
          if (tag === null || BANNED_CREATE.has(tag.toLowerCase())) report(top, 'no-raw-html', `document.createElement(${tag === null ? 'computed' : `"${tag}"`}) is not allowed; render elements with JSX`)
        }
        return
      case 'location':
        return onLocation(top, names, role)
      case 'navigator':
        if (b === 'sendBeacon') {
          if (role === 'call') return checkUrl(report, top, args[0], 'navigator.sendBeacon')
          return report(top, 'no-remote-request', 'navigator.sendBeacon may only be called directly, with a relative URL')
        }
        if (names.length === 1) return report(top, 'no-global-alias', 'navigator cannot be passed around or aliased')
        return
      default:
        if (STORAGE.has(a!)) return report(top, 'no-storage', `${a} is not allowed in edits; keep state in React, save data through the readonly client`)
        if (CROSS_WINDOW.has(a!)) return report(top, 'no-cross-window', `window.${a} is not allowed`)
        if (WORKERS.has(a!)) return report(top, 'no-worker', `${a} is not allowed in edits`)
    }
  }

  const onLocation = (top: N, names: string[], role: string) => {
    if (names.length === 1 && role !== 'typeof') return report(top, 'no-navigation', 'location cannot be assigned or passed around; read location.pathname or location.search, navigate with links')
    if (role === 'assign' || role === 'call') return report(top, 'no-navigation', `location.${names[1]} ${role === 'call' ? '()' : '='} is not allowed; navigate with a link that has a relative href`)
  }

  walk(ast, (node, parent) => {
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
      case 'ExportNamedDeclaration': {
        const spec = literalText(node.source)
        if (spec !== null) checkSpecifier(node, spec)
        break
      }
      case 'ImportExpression': {
        const spec = literalText(node.source)
        if (spec !== null) checkSpecifier(node, spec)
        else report(node, 'no-dynamic-import', 'import() with a computed specifier is not allowed')
        break
      }
      case 'CallExpression': {
        const callee = node.callee as N
        const args = node.arguments as N[]
        if (callee.type === 'Identifier' && callee.name === 'require' && !declared.has('require')) {
          const spec = literalText(args[0])
          if (spec !== null) checkSpecifier(node, spec)
          else report(node, 'no-dynamic-import', 'require() with a computed specifier is not allowed')
        }
        if (callee.type === 'MemberExpression') {
          const prop = callee.computed ? literalText(callee.property) : ((callee.property as N).name as string)
          if (prop === 'insertAdjacentHTML') report(node, 'no-raw-html', 'insertAdjacentHTML is not allowed; render with JSX')
          if (prop === 'setAttribute' || prop === 'setAttributeNS') {
            const name = literalText(args[prop === 'setAttribute' ? 0 : 1])
            const value = args[prop === 'setAttribute' ? 1 : 2]
            if (name === null) report(node, 'no-computed-url', 'setAttribute with a computed attribute name is not allowed')
            else if (name.toLowerCase() === 'srcdoc' || /^on/i.test(name)) report(node, 'no-raw-html', `setAttribute("${name}") is not allowed`)
            else if (URL_ATTRS.has(name.toLowerCase())) checkUrl(report, node, value, `setAttribute("${name}")`)
          }
          if ((prop === 'createElement' || prop === 'cloneElement') && !(callee.object && (callee.object as N).type === 'Identifier' && (callee.object as N).name === 'document')) {
            report(node, 'no-raw-html', `${prop}() is not allowed in edits; write JSX`)
          }
        } else if (callee.type === 'Identifier' && (callee.name === 'createElement' || callee.name === 'cloneElement') && !declared.has(callee.name as string)) {
          report(node, 'no-raw-html', `${callee.name as string}() is not allowed in edits; write JSX`)
        }
        break
      }
      case 'Identifier': {
        const name = node.name as string
        if (WATCHED.has(name) && !declared.has(name) && isReference(node, parent)) onGlobal(node)
        break
      }
      case 'MemberExpression': {
        const prop = node.computed ? literalText(node.property) : ((node.property as N).name as string)
        if (prop === 'constructor' || prop === '__proto__') report(node, 'no-constructor-access', `.${prop} is not allowed in edits`)
        if ((prop === 'cookie' || prop === 'domain') && (node.object as N).type === 'Identifier' && ((node.object as N).name as string) === 'document' && declared.has('document')) {
          report(node, 'no-document-cookie', `document.${prop} is not allowed`)
        }
        break
      }
      case 'AssignmentExpression': {
        const left = node.left as N
        if (left.type === 'MemberExpression') {
          const prop = left.computed ? literalText(left.property) : ((left.property as N).name as string)
          if (prop === 'innerHTML' || prop === 'outerHTML' || prop === 'srcdoc') report(left, 'no-raw-html', `Assigning ${prop} is not allowed; render with JSX`)
          else if (prop && URL_ATTRS.has(prop.toLowerCase())) checkUrl(report, left, node.right as N, `Setting .${prop}`)
        }
        if (left.type === 'ObjectPattern') checkDestructure(left, node.right as N)
        break
      }
      case 'VariableDeclarator':
        if ((node.id as N).type === 'ObjectPattern' && node.init) checkDestructure(node.id as N, node.init as N)
        break
      case 'Property':
        if (!node.computed && ((node.key as N).name === 'dangerouslySetInnerHTML' || (node.key as N).value === 'dangerouslySetInnerHTML')) {
          report(node, 'no-raw-html', 'dangerouslySetInnerHTML is not allowed; render with JSX')
        }
        break
      case 'Literal':
        if (typeof node.value === 'string') checkCssText(report, node, node.value, false)
        break
      case 'TemplateLiteral': {
        const quasis = node.quasis as N[]
        quasis.forEach((q, i) => checkCssText(report, node, (q.value as { cooked?: string }).cooked ?? '', i < quasis.length - 1))
        break
      }
      case 'JSXOpeningElement': {
        const nameNode = node.name as N
        const tag = nameNode.type === 'JSXIdentifier' ? (nameNode.name as string) : ''
        if (BANNED_TAGS.has(tag)) report(node, 'no-raw-html', `<${tag}> is not allowed in edits`)
        for (const a of node.attributes as N[]) {
          if (a.type !== 'JSXAttribute') continue
          const name = attrName(a)
          const lower = name.toLowerCase()
          if (name === 'dangerouslySetInnerHTML' || lower === 'srcdoc') report(a, 'no-raw-html', `${name} is not allowed; render with JSX`)
          else if (URL_ATTRS.has(lower)) {
            if (a.value === null) continue
            checkUrl(report, a, a.value as N, `<${tag || 'element'} ${name}>`, { allowMail: lower === 'href' })
          }
        }
        break
      }
    }
  })

  function checkDestructure(pattern: N, init: N) {
    let root = init
    while (root.type === 'MemberExpression') root = root.object as N
    if (root.type === 'Identifier' && GLOBAL_OBJECTS.has(root.name as string) && !declared.has(root.name as string)) {
      report(pattern, 'no-global-alias', `Destructuring from ${root.name as string} is not allowed; use ${root.name as string}.<property> directly`)
    }
  }

  // protected elements: every one in the original file stays, and none is hidden
  if (sels.length) {
    const now = countProtected(ast, sels)
    for (const s of sels) {
      const before = protectedBase?.get(s.raw) ?? 0
      const after = now.get(s.raw) ?? 0
      if (after < before) push({ file: path, line: 1, column: 1, text: `The element ${s.raw} is protected by the app and must stay in this panel (${before} before, ${after} now) [protected-element]`, rule: 'protected-element' })
    }
    walk(ast, (n) => {
      if (n.type !== 'JSXOpeningElement') return
      const hit = sels.find((s) => matchesProtected(n, s))
      if (!hit) return
      const how = hidesElement(n)
      if (how) report(n, 'protected-element', `The element ${hit.raw} is protected by the app and must stay visible; remove ${how}`)
    })
  }
}

// --- CSS files of the zone ---

const GLOBAL_SELECTOR = /(^|[\s,>+~(])(html|body|:root|:host|\*)(?=$|[\s,>+~.:#[{)])/i
const PLEATKIT_SELECTOR = /\.mk-|\[data-pleatkit|pleatkit-ui/i

export function cssRules(path: string, source: string, ctx: Pick<CheckContext, 'protected'>): CompileError[] {
  const errors: CompileError[] = []
  const text = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  const lineAt = (i: number) => text.slice(0, i).split('\n').length
  const report = (i: number, rule: StaticRule, msg: string) => errors.push({ file: path, line: lineAt(i), column: 1, text: `${msg} [${rule}]`, rule })
  const sels = parseProtected(ctx.protected)
  for (const m of text.matchAll(/url\(\s*(['"]?)([^)'"]*)/gi)) {
    const url = m[2]!.trim()
    if (/^data:/i.test(url)) continue
    if (ABSOLUTE_URL.test(url) || JS_URL.test(url) || /^var\(/i.test(url) || /^attr\(/i.test(url)) report(m.index!, 'no-remote-css', `url(${url.slice(0, 60)}) is not allowed: ${HINT.css}`)
  }
  for (const m of text.matchAll(/@import\s+(?:url\()?\s*['"]?([^'");\s]+)/gi)) {
    const spec = m[1]!
    if (!(spec.startsWith('./') || spec.startsWith('../'))) report(m.index!, 'no-remote-css', `@import "${spec}" is not allowed; only other CSS files of the dynamic zone`)
  }
  for (const m of text.matchAll(/expression\s*\(|behavior\s*:|-moz-binding/gi)) report(m.index!, 'no-remote-css', `"${m[0]}" is not allowed in styles`)
  // selectors: the text before each `{` that is not an at-rule
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') {
      const sel = text.slice(start, i).trim()
      if (sel && !sel.startsWith('@')) {
        if (GLOBAL_SELECTOR.test(sel)) report(start, 'no-global-css', `The selector "${sel.slice(0, 60)}" reaches outside the panels; style elements of the panel by class`)
        if (PLEATKIT_SELECTOR.test(sel)) report(start, 'no-global-css', `The selector "${sel.slice(0, 60)}" targets pleatkit's own interface`)
        for (const s of sels) {
          const token = s.kind === 'attr' ? `[${s.name}` : s.kind === 'class' ? `.${s.name}` : `#${s.name}`
          if (sel.includes(token)) report(start, 'protected-element', `The selector "${sel.slice(0, 60)}" styles the protected element ${s.raw}`)
        }
      }
      start = i + 1
    } else if (ch === '}' || ch === ';') start = i + 1
  }
  return errors
}

// --- default exports (one rule for browser and server: `export default 42` is refused by both) ---

type DefaultKind = 'component' | 'not-component' | 'missing' | 'unknown'

function classify(expr: N | undefined, ast: N, follow: (spec: string, name: string) => DefaultKind): DefaultKind {
  if (!expr) return 'missing'
  switch (expr.type) {
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
    case 'ClassDeclaration':
    case 'ClassExpression':
    case 'CallExpression':
    case 'MemberExpression':
      return 'component'
    case 'Identifier':
      return resolveName(expr.name as string, ast, follow)
    case 'ParenthesizedExpression':
    case 'TSAsExpression':
      return classify(expr.expression as N, ast, follow)
    case 'ConditionalExpression': {
      const a = classify(expr.consequent as N, ast, follow)
      const b = classify(expr.alternate as N, ast, follow)
      return a === 'not-component' || b === 'not-component' ? 'not-component' : 'component'
    }
    default:
      // literals, templates, arrays, plain objects, arithmetic, JSX elements (an element is not a component)
      return 'not-component'
  }
}

function resolveName(name: string, ast: N, follow: (spec: string, name: string) => DefaultKind): DefaultKind {
  for (const stmt of ast.body as N[]) {
    const decl = stmt.type === 'ExportNamedDeclaration' && stmt.declaration ? (stmt.declaration as N) : stmt
    if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && (decl.id as N | null)?.name === name) return 'component'
    if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations as N[]) {
        if ((d.id as N).type === 'Identifier' && (d.id as N).name === name) return d.init ? classify(d.init as N, ast, follow) : 'not-component'
      }
    }
    if (stmt.type === 'ImportDeclaration') {
      for (const s of stmt.specifiers as N[]) {
        if ((s.local as N).name !== name) continue
        const spec = literalText(stmt.source)!
        if (s.type === 'ImportDefaultSpecifier') return follow(spec, 'default')
        if (s.type === 'ImportSpecifier') return follow(spec, ((s.imported as N).name ?? (s.imported as N).value) as string)
        return 'unknown'
      }
    }
  }
  return 'unknown'
}

function exportedKind(ast: N, exportName: string, follow: (spec: string, name: string) => DefaultKind): DefaultKind {
  for (const stmt of ast.body as N[]) {
    if (exportName === 'default' && stmt.type === 'ExportDefaultDeclaration') return classify(stmt.declaration as N, ast, follow)
    if (stmt.type === 'ExportNamedDeclaration') {
      if (stmt.declaration) {
        const d = stmt.declaration as N
        if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && (d.id as N | null)?.name === exportName) return 'component'
        if (d.type === 'VariableDeclaration') {
          for (const v of d.declarations as N[]) if ((v.id as N).name === exportName) return v.init ? classify(v.init as N, ast, follow) : 'not-component'
        }
      }
      for (const s of (stmt.specifiers as N[]) ?? []) {
        const exported = ((s.exported as N).name ?? (s.exported as N).value) as string
        if (exported !== exportName) continue
        const local = ((s.local as N).name ?? (s.local as N).value) as string
        const spec = literalText(stmt.source)
        return spec !== null ? follow(spec, local) : resolveName(local, ast, follow)
      }
    }
  }
  return 'missing'
}

// --- everything ---

export interface StaticCheckOptions {
  /** Panels that must keep a default-exported component (mounted `<Dynamic>` panels). */
  components?: string[]
}

/**
 * The static part of `check`, identical in the browser and on the agent server: rules for scripts and CSS,
 * protected elements, and default exports of panels. Compile errors (syntax, imports that do not resolve) come
 * from the bundle step, not from here.
 */
export async function staticCheck(files: FileMap, ctx: CheckContext, transform: TransformFn, options: StaticCheckOptions = {}): Promise<CompileError[]> {
  const errors: CompileError[] = []
  const seen = new Set<string>()
  const push = (e: CompileError) => {
    const k = `${e.file}:${e.line}:${e.column}:${e.rule}`
    if (seen.has(k)) return
    seen.add(k)
    errors.push(e)
  }
  const sels = parseProtected(ctx.protected)
  const parsed = new Map<string, Parsed | null>()
  const parse = async (path: string, source: string) => {
    if (!parsed.has(path)) parsed.set(path, await parseFile(path, source, transform))
    return parsed.get(path)!
  }
  for (const [path, source] of Object.entries(files)) {
    if (path.endsWith('.css')) {
      cssRules(path, source, ctx).forEach(push)
      continue
    }
    if (!SCRIPT.test(path)) continue
    const p = await parse(path, source)
    if (!p) continue
    let base: Map<string, number> | null = null
    if (sels.length && ctx.base?.[path] !== undefined) {
      const bp = await parseFile(path, ctx.base[path]!, transform)
      base = bp ? countProtected(bp.ast, sels) : null
    }
    rulesForFile(path, p, ctx, push, base, sels)
  }
  // a protected element whose whole file was removed
  if (sels.length && ctx.base) {
    for (const [path, source] of Object.entries(ctx.base)) {
      if (path in files || !SCRIPT.test(path)) continue
      const bp = await parseFile(path, source, transform)
      const counts = bp ? countProtected(bp.ast, sels) : new Map<string, number>()
      for (const [raw, n] of counts) if (n > 0) push({ file: path, line: 0, column: 0, text: `${path} holds the protected element ${raw} and cannot be removed [protected-element]`, rule: 'protected-element' })
    }
  }
  for (const e of await defaultExportErrors(files, options.components ?? [], parse)) push(e)
  return errors
}

const RESOLVE = ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.js']

async function defaultExportErrors(files: FileMap, components: string[], parse: (path: string, source: string) => Promise<Parsed | null>): Promise<CompileError[]> {
  const out: CompileError[] = []
  for (const path of components.filter((p) => SCRIPT.test(p))) {
    if (!(path in files)) {
      out.push({ file: path, line: 0, column: 0, text: `${path} was removed, but a <Dynamic> panel needs it [default-export]`, rule: 'default-export' })
      continue
    }
    const visiting = new Set<string>()
    const kindOf = async (file: string, name: string): Promise<DefaultKind> => {
      const key = `${file}#${name}`
      if (visiting.has(key)) return 'unknown'
      visiting.add(key)
      const p = await parse(file, files[file]!)
      if (!p) return 'unknown' // a syntax error, reported by the compile step
      // `follow` must be synchronous for the walker: resolve re-exports one level deep, lazily, afterwards
      const pending: { spec: string; name: string }[] = []
      const kind = exportedKind(p.ast, name, (spec, n) => {
        pending.push({ spec, name: n })
        return 'unknown'
      })
      if (kind !== 'unknown' || pending.length === 0) return kind
      const { spec, name: n } = pending[0]!
      if (!(spec.startsWith('./') || spec.startsWith('../'))) return 'component' // from the host app: trust it
      const target = normalizePath(dirnameOf(file) + '/' + spec)
      const hit = RESOLVE.map((e) => target + e).find((c) => c in files)
      return hit ? kindOf(hit, n) : 'unknown'
    }
    const kind = await kindOf(path, 'default')
    if (kind === 'missing') out.push({ file: path, line: 0, column: 0, text: `no default export in ${path}: a mounted panel needs export default function ... [default-export]`, rule: 'default-export' })
    else if (kind === 'not-component') out.push({ file: path, line: 0, column: 0, text: `the default export of ${path} is not a React component (export a function component) [default-export]`, rule: 'default-export' })
  }
  return out
}

export { isComponentExport } from './component.js'
export type { AcornNode }
