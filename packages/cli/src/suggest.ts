import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { globSync } from 'tinyglobby'

/**
 * `pleatkit init --suggest` (brainstorm 17 §10): from the app's import graph, propose the zones, the readonly re-export
 * modules, the externals and the plugin block. Deterministic and free: it parses the sources with the TypeScript
 * parser, never runs the app or its vite.config.
 */

export interface PanelChoice {
  /** Source file of the panel, relative to the app root. */
  file: string
  /** Panel id (kebab-case); default: from the file or component name. */
  id?: string
  /** Exported component of the file; default: the default export, else the one named like the file. */
  component?: string
}

export interface SuggestOptions {
  root: string
  /** The panels, chosen by the user (`--panels`); without it a heuristic picks them. */
  panels?: PanelChoice[]
  /** Heuristic mode: how many panels at most (default 5). */
  maxPanels?: number
}

export interface HookProp {
  prop: string
  /** The hook call as written in the panel, e.g. `route.useSearch()`. */
  hook: string
  /** What the page needs to call it: imports and module-level lines, e.g. `const route = getRouteApi('/_authenticated/tasks/')`. */
  setup: string[]
  file: string
  line: number
}

export interface RenderSite {
  file: string
  line: number
  /** The element as the page writes it today, e.g. `<UsersTable data={users} …>`. */
  element: string
  /** Props passed today (JSX attributes). */
  attributes: string[]
  /** Props the `<Dynamic>` needs here: the attributes plus the hook results. */
  props: string[]
  /** Lines to add to the page before the render (hooks that move out of the panel). */
  add: string[]
  replacement: string
}

export interface PanelPlan {
  id: string
  file: string
  component: string
  target: string
  /** `copy` when the file has other users than its render sites (a story, a test, a barrel): the original stays. */
  action: 'move' | 'copy'
  /** Who else imports the panel's file (the reason for `copy`). */
  otherUsers: string[]
  helpers: { file: string; target: string; action: 'move' | 'copy'; sharedWith?: string[] }[]
  /** Files the panel imports that stay where they are (a global stylesheet of a copied component). */
  stays: { file: string; reason: string }[]
  /** Modules only this panel imports that stay in core (state, dialogs), reached through a readonly re-export. */
  keptInCore: { file: string; reason: string }[]
  hookProps: HookProp[]
  renderSites: RenderSite[]
  /** Every prop the panel needs at its render sites (attributes and hook results). */
  props: string[]
  /** The import lines of each moved file after the move (only the ones that change). */
  imports: { file: string; from: string; to: string; line: string }[]
  /** Tests and stories that import moved files (they need a new path); empty when the panel is copied. */
  alsoImportedBy: string[]
  /** Heuristic mode: why this file was picked. */
  reasons?: string[]
}

export interface ReexportName {
  name: string
  as?: string
  type: boolean
}

export interface ReadonlyModulePlan {
  path: string
  spec: string
  from: { module: string; spec: string; names: ReexportName[] }[]
  usedBy: string[]
  source: string
}

export interface Candidate {
  file: string
  component: string
  score: number
  reasons: string[]
  pages: string[]
  /** First render line in the page (earlier panels on a page rank first on a tie). */
  line: number
}

export interface SuggestPlan {
  root: string
  mode: 'panels' | 'heuristic'
  alias: { at: string | null; vite: Record<string, string>; tsconfig: Record<string, string>; todo: string[] }
  panels: PanelPlan[]
  readonlyModules: ReadonlyModulePlan[]
  /** Existing app files that go into the readonly zone as they are (the UI kit files used, small shared modules). */
  readonlyFiles: string[]
  /** The modules the panels import that go into the readonly zone whole, with the files each pulls in (the kit is listed per file). */
  readonlyDirect: { module: string; spec: string; files: string[]; kit: boolean }[]
  readonlyZone: string[]
  externals: string[]
  /** Why each external is there. */
  externalReasons: Record<string, string>
  css: { mode: 'tailwind' | 'palette'; tailwindEntry?: string; note?: string }
  /** clean: only component files (no stylesheets, tests or stories), so `'@/components/ui/*'` can list it. */
  kit: { dir: string; layout: 'flat' | 'folders'; clean: boolean } | null
  designSystem: { components: string[] } | null
  core: { count: number; types: string[] }
  plugin: string
  manifest: { panels: string[]; dynamic: string[]; readonly: string[] }
  notes: string[]
  candidates: Candidate[]
}

// --- the project ---

const SCRIPT_RE = /\.(tsx|ts|jsx|js|mts|mjs)$/
const CSS_RE = /\.css$/
const TEST_RE = /\.(test|spec|stories|story)\.[cm]?[jt]sx?$|(^|\/)(__tests__|__mocks__|__stories__|stories|test|tests|e2e)\//
const RESOLVE_SUFFIX = ['', '.tsx', '.ts', '.jsx', '.js', '.mts', '.mjs', '.css', '/index.tsx', '/index.ts', '/index.jsx', '/index.js']
const ROUTER_PACKAGES = new Set(['@tanstack/react-router', 'react-router', 'react-router-dom', 'wouter', '@reach/router'])
const DEFAULT_EXTERNALS = ['react', 'react-dom', 'react/jsx-runtime']
/** Icon sets importable from the package root: listed when the app depends on them, so edits can add icons (lazy externals). */
const ICON_PACKAGES = ['lucide-react', '@radix-ui/react-icons', '@ant-design/icons', '@tabler/icons-react', '@phosphor-icons/react', 'react-feather', '@iconify/react']
const CHART_PACKAGES = /^(recharts|react-apexcharts|apexcharts|chart\.js|react-chartjs-2|echarts|echarts-for-react|@nivo\/.*|victory|@ant-design\/(charts|plots)|highcharts|highcharts-react-official|@visx\/.*|d3(-.*)?|lightweight-charts|@mui\/x-charts|@tremor\/react|@unovis\/.*)$/
const TABLE_PACKAGES = /^(@tanstack\/react-table|ag-grid-react|ag-grid-community|@mui\/x-data-grid|react-table|react-data-grid|@glideapps\/glide-data-grid|mantine-react-table|material-react-table)$/
/** Modules about one domain (data, state, a feature): reached through a readonly re-export, not put in the zone whole. */
const DOMAIN_RE = /(^|\/)(features?|modules|pages|views|screens|routes|app|data|api|apis|queries|services|store|stores|redux|slices|state|contexts?|providers?|mocks?)(\/|$)/
const LAYOUT_RE = /(^|\/)(layouts?|header|footer|sidebar|nav(bar|igation)?|breadcrumbs?|page-?meta|page-?header|page-?breadcrumb|app-?shell|topbar|menu)(\/|\.|-|$)|\b(Layout|Header|Footer|Sidebar|Nav|Navbar|Navigation|Breadcrumb|PageMeta|PageHeader|PageBreadcrumb|AppShell|Topbar|Menu|Provider|Dialog|Modal|Drawer|Form|Auth|Login|SignIn|SignUp|Search|ThemeToggle|ThemeSwitch|ProfileDropdown|Button|Tabs?|Filters?|FilterControls|Controls|Picker|Select|Toggle|Input|Pagination)$/
const STATEFUL_NAME_RE = /(dialog|modal|drawer|provider|context|store|form)s?(\.|-|$)/i

interface Binding {
  local: string
  imported: string // 'default' | '*' | name
  type: boolean
}

interface ImportRec {
  spec: string
  file: string | null
  pkg: string | null
  asset: boolean
  /** The whole declaration is `import type`. */
  typeOnly: boolean
  bindings: Binding[]
  reexport: boolean
  line: number
  text: string
}

interface JsxUse {
  tag: string
  line: number
  attributes: { name: string; value: string | null }[]
  spread: boolean
  text: string
}

interface Mod {
  path: string
  source: string
  lines: number
  script: boolean
  sf: ts.SourceFile | null
  imports: ImportRec[]
  /** export name → local name (declared here) */
  localExports: Map<string, string>
  /** export name → [module file, imported name] */
  reexports: Map<string, [string, string]>
  stars: string[]
  jsx: JsxUse[]
  /** `component: X`, `element: X`, `Component: X` identifiers (route tables). */
  routeRefs: Set<string>
  jsxCount: number
  isRouteTable: boolean
}

const toPosix = (p: string): string => p.split(path.sep).join('/')
const kebab = (s: string): string =>
  s
    .replace(/\.[^.]+$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
const pascal = (s: string): string => kebab(s).split('-').map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : '')).join('')
const stripExt = (p: string): string => p.replace(/\.(d\.ts|tsx|ts|jsx|js|mts|mjs)$/, '')
const isTest = (p: string): boolean => TEST_RE.test(p)
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A multi-line import on one line: `import { a, b } from 'x'`. */
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').replace(/,\s*}/g, ' }').replace(/{\s+/g, '{ ')

function scriptKind(p: string): ts.ScriptKind {
  if (p.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (p.endsWith('.ts') || p.endsWith('.mts')) return ts.ScriptKind.TS
  return ts.ScriptKind.JSX
}

function stringsIn(node: ts.Node): string[] {
  const out: string[] = []
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteralLike(n)) out.push(n.text)
    else if (ts.isTemplateExpression(n)) out.push(n.templateSpans.map((s) => s.literal.text).join(''))
    n.forEachChild(visit)
  }
  visit(node)
  return out
}

const normDir = (s: string): string => s.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '').replace(/\/\*$/, '').replace(/\/$/, '')

class Project {
  readonly mods = new Map<string, Mod>()
  readonly files: string[]
  /** importer files (non-test) of each module */
  readonly importers = new Map<string, Set<string>>()
  readonly testImporters = new Map<string, Set<string>>()
  readonly aliases: [string, string][]

  constructor(
    readonly root: string,
    aliases: Record<string, string>,
  ) {
    this.aliases = Object.entries(aliases).sort((a, b) => b[0].length - a[0].length)
    this.files = globSync(['src/**/*.{tsx,ts,jsx,js,mts,mjs,css}'], { cwd: root, ignore: ['**/node_modules/**', '**/dist/**', '**/*.d.ts'], onlyFiles: true }).map(toPosix).sort()
    for (const f of this.files) this.mods.set(f, this.parse(f))
    for (const m of this.mods.values()) {
      for (const i of m.imports) {
        if (!i.file) continue
        const map = isTest(m.path) ? this.testImporters : this.importers
        if (!map.has(i.file)) map.set(i.file, new Set())
        map.get(i.file)!.add(m.path)
      }
    }
  }

  exists(rel: string): boolean {
    if (this.mods.has(rel)) return true
    const abs = path.join(this.root, rel)
    return fs.existsSync(abs) && fs.statSync(abs).isFile()
  }

  /** A specifier as the app resolves it: a project file, a package, or an asset. */
  resolve(spec: string, importer: string): { file: string | null; pkg: string | null; asset: boolean } {
    const clean = spec.split('?')[0]!
    let base: string | null = null
    if (clean.startsWith('./') || clean.startsWith('../') || clean === '.' || clean === '..') base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), clean))
    else if (clean.startsWith('/')) base = clean.slice(1)
    else {
      for (const [key, dir] of this.aliases) {
        if (clean === key) base = dir
        else if (clean.startsWith(key.endsWith('/') ? key : key + '/')) base = dir + '/' + clean.slice(key.length).replace(/^\//, '')
        if (base !== null) break
      }
    }
    if (base === null) {
      const parts = clean.split('/')
      return { file: null, pkg: clean.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!, asset: false }
    }
    for (const suffix of RESOLVE_SUFFIX) {
      const candidate = base + suffix
      if (this.exists(candidate)) {
        const asset = !SCRIPT_RE.test(candidate) && !CSS_RE.test(candidate)
        return { file: candidate, pkg: null, asset }
      }
    }
    return { file: null, pkg: null, asset: true }
  }

  private parse(rel: string): Mod {
    const source = fs.readFileSync(path.join(this.root, rel), 'utf8')
    const mod: Mod = {
      path: rel,
      source,
      lines: source.split('\n').length,
      script: SCRIPT_RE.test(rel),
      sf: null,
      imports: [],
      localExports: new Map(),
      reexports: new Map(),
      stars: [],
      jsx: [],
      routeRefs: new Set(),
      jsxCount: 0,
      isRouteTable: false,
    }
    if (!mod.script) return mod
    const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, scriptKind(rel))
    mod.sf = sf
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
    const addImport = (spec: string, node: ts.Node, bindings: Binding[], typeOnly: boolean, reexport: boolean) => {
      const r = this.resolve(spec, rel)
      mod.imports.push({ spec, file: r.file && !r.asset ? r.file : null, pkg: r.pkg, asset: r.asset && !r.pkg, typeOnly, bindings, reexport, line: lineOf(node), text: oneLine(node.getText(sf)) })
      return r
    }
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
        const c = st.importClause
        const bindings: Binding[] = []
        const typeOnly = Boolean(c?.isTypeOnly)
        if (c?.name) bindings.push({ local: c.name.text, imported: 'default', type: typeOnly })
        if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) bindings.push({ local: c.namedBindings.name.text, imported: '*', type: typeOnly })
        if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) {
          for (const e of c.namedBindings.elements) bindings.push({ local: e.name.text, imported: (e.propertyName ?? e.name).text, type: typeOnly || e.isTypeOnly })
        }
        addImport(st.moduleSpecifier.text, st, bindings, typeOnly, false)
      } else if (ts.isExportDeclaration(st)) {
        if (st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
          const bindings: Binding[] = []
          if (st.exportClause && ts.isNamedExports(st.exportClause)) {
            for (const e of st.exportClause.elements) bindings.push({ local: e.name.text, imported: (e.propertyName ?? e.name).text, type: st.isTypeOnly || e.isTypeOnly })
          } else if (st.exportClause && ts.isNamespaceExport(st.exportClause)) bindings.push({ local: st.exportClause.name.text, imported: '*', type: st.isTypeOnly })
          const r = addImport(st.moduleSpecifier.text, st, bindings, st.isTypeOnly, true)
          const target = r.file && !r.asset ? r.file : null
          if (!st.exportClause) {
            if (target) mod.stars.push(target)
          } else if (target) for (const b of bindings) mod.reexports.set(b.local, [target, b.imported])
        } else if (st.exportClause && ts.isNamedExports(st.exportClause)) {
          for (const e of st.exportClause.elements) mod.localExports.set(e.name.text, (e.propertyName ?? e.name).text)
        }
      } else if (ts.isExportAssignment(st)) {
        mod.localExports.set('default', ts.isIdentifier(st.expression) ? st.expression.text : 'default')
      } else {
        const flags = ts.canHaveModifiers(st) ? (ts.getModifiers(st) ?? []).map((m) => m.kind) : []
        if (!flags.includes(ts.SyntaxKind.ExportKeyword)) continue
        const isDefault = flags.includes(ts.SyntaxKind.DefaultKeyword)
        if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) mod.localExports.set(d.name.text, d.name.text)
        } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) {
          mod.localExports.set(isDefault ? 'default' : st.name.text, st.name.text)
        } else if (isDefault) mod.localExports.set('default', 'default')
      }
    }
    const visit = (n: ts.Node) => {
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) mod.jsxCount++
      const opening = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null
      if (opening) {
        const tag = opening.tagName.getText(sf)
        const attributes: JsxUse['attributes'] = []
        let spread = false
        for (const a of opening.attributes.properties) {
          if (ts.isJsxSpreadAttribute(a)) spread = true
          else attributes.push({ name: a.name.getText(sf), value: a.initializer ? (ts.isJsxExpression(a.initializer) ? (a.initializer.expression?.getText(sf) ?? null) : a.initializer.getText(sf)) : null })
        }
        mod.jsx.push({ tag, line: lineOf(opening), attributes, spread, text: opening.getText(sf).replace(/\s+/g, ' ') })
      }
      // route tables: { path, component: Users } / { element: <X /> } / createFileRoute(…)({ component })
      if (ts.isPropertyAssignment(n) && /^(component|Component|element|pendingComponent)$/.test(n.name.getText(sf))) {
        const init = ts.isParenthesizedExpression(n.initializer) ? n.initializer.expression : n.initializer
        if (ts.isIdentifier(init)) mod.routeRefs.add(init.text)
        const el = ts.isJsxSelfClosingElement(init) ? init : ts.isJsxElement(init) ? init.openingElement : null
        if (el) mod.routeRefs.add(el.tagName.getText(sf).split('.')[0]!)
      }
      // <Route element={<Page />} /> and <Route component={Page} />
      if (ts.isJsxAttribute(n) && /^(element|component|Component)$/.test(n.name.getText(sf)) && n.initializer && ts.isJsxExpression(n.initializer) && n.initializer.expression) {
        const e = n.initializer.expression
        const el = ts.isJsxSelfClosingElement(e) ? e : ts.isJsxElement(e) ? e.openingElement : null
        if (el) mod.routeRefs.add(el.tagName.getText(sf).split('.')[0]!)
        else if (ts.isIdentifier(e)) mod.routeRefs.add(e.text)
      }
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(sf)
        if (/^(createFileRoute|createRoute|createRootRoute|createBrowserRouter|createHashRouter|createMemoryRouter|useRoutes|createLazyFileRoute)$/.test(callee)) mod.isRouteTable = true
        // dynamic imports, also React.lazy(() => import('./x'))
        if (n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
          let bindings: Binding[] = []
          const lazy = n.parent && findLazyName(n, sf)
          if (lazy) bindings = [{ local: lazy.local, imported: lazy.imported, type: false }]
          addImport(n.arguments[0].text, n, bindings, false, false)
        }
      }
      if (ts.isJsxOpeningElement(n) && n.tagName.getText(sf) === 'Route') mod.isRouteTable = true
      n.forEachChild(visit)
    }
    sf.forEachChild(visit)
    // `import { ColumnsType } from 'antd/es/table'` used only in types is a type import: no external, `export type`
    const valueUses = new Set<string>()
    const anyUses = new Set<string>()
    const visitIds = (n: ts.Node) => {
      if (ts.isIdentifier(n) && isReference(n)) {
        anyUses.add(n.text)
        if (!inTypePosition(n)) valueUses.add(n.text)
      }
      n.forEachChild(visitIds)
    }
    for (const st of sf.statements) if (!ts.isImportDeclaration(st)) visitIds(st)
    for (const imp of mod.imports) {
      if (imp.reexport) continue
      for (const b of imp.bindings) if (!b.type && b.imported !== '*' && anyUses.has(b.local) && !valueUses.has(b.local)) b.type = true
    }
    return mod
  }

  mod(p: string): Mod | undefined {
    return this.mods.get(p)
  }

  /** Where `name` exported by `file` is declared (follows re-exports and `export *`). */
  resolveExport(file: string, name: string, seen = new Set<string>()): [string, string] | null {
    const key = file + '#' + name
    if (seen.has(key)) return null
    seen.add(key)
    const m = this.mods.get(file)
    if (!m) return null
    if (m.localExports.has(name)) return [file, name]
    const re = m.reexports.get(name)
    if (re) return this.resolveExport(re[0], re[1], seen) ?? re
    if (name === 'default') return null
    for (const s of m.stars) {
      const r = this.resolveExport(s, name, seen)
      if (r) return r
    }
    return null
  }

  /** The binding's declaration, when it is from a project module. */
  bindingTarget(m: Mod, local: string): { imp: ImportRec; binding: Binding; target: [string, string] | null } | null {
    for (const imp of m.imports) {
      if (imp.reexport) continue
      const b = imp.bindings.find((x) => x.local === local)
      if (!b) continue
      return { imp, binding: b, target: imp.file ? (b.imported === '*' ? [imp.file, '*'] : this.resolveExport(imp.file, b.imported)) : null }
    }
    return null
  }

  /** Spec for a project file under an alias (`@/components/ui/table`), or null. */
  aliasSpec(file: string): string | null {
    let best: [string, string] | null = null
    for (const [key, dir] of this.aliases) {
      if (file === dir || file.startsWith(dir + '/')) {
        if (!best || dir.length > best[1].length || (dir.length === best[1].length && key === '@')) best = [key, dir]
      }
    }
    if (!best) return null
    const rest = stripExt(file.slice(best[1].length)).replace(/\/index$/, '').replace(/^\//, '')
    return rest ? `${best[0].replace(/\/$/, '')}/${rest}` : best[0]
  }
}

/** An identifier that refers to a binding (not a property name or a declaration's own name). */
function isReference(n: ts.Identifier): boolean {
  const p = n.parent
  if (!p) return false
  if ((ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) && (ts.isPropertyAccessExpression(p) ? p.name : p.right) === n) return false
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isJsxAttribute(p)) && p.name === n) return false
  if ((ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isEnumDeclaration(p)) && p.name === n) return false
  return true
}

/** Inside a type (a type reference, `typeof x` in a type, an interface's `extends`): erased from the JavaScript. */
function inTypePosition(n: ts.Node): boolean {
  let c: ts.Node = n
  while (c.parent) {
    const p: ts.Node = c.parent
    if (ts.isExpressionWithTypeArguments(p)) return Boolean(p.parent && ts.isHeritageClause(p.parent) && ts.isInterfaceDeclaration(p.parent.parent))
    if (ts.isTypeNode(p)) return true
    if (ts.isSourceFile(p)) return false
    c = p
  }
  return false
}

/** `const X = lazy(() => import('./x'))` and `.then((m) => ({ default: m.Name }))`. */
function findLazyName(call: ts.CallExpression, sf: ts.SourceFile): { local: string; imported: string } | null {
  let n: ts.Node = call
  let imported = 'default'
  for (let i = 0; i < 8 && n.parent; i++) {
    n = n.parent
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'then') {
      const m = /default\s*:\s*\w+\.(\w+)/.exec(n.getText(sf))
      if (m) imported = m[1]!
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) return /lazy\s*\(/.test(n.initializer?.getText(sf) ?? '') ? { local: n.name.text, imported } : null
  }
  return null
}

// --- configuration: aliases, Tailwind ---

function readJson(file: string): Record<string, unknown> | null {
  try {
    const r = ts.parseConfigFileTextToJson(file, fs.readFileSync(file, 'utf8'))
    return (r.config as Record<string, unknown>) ?? null
  } catch {
    return null
  }
}

/** `paths` of the app's tsconfig files (references and relative `extends` followed): alias → directory. */
export function tsconfigAliases(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const seen = new Set<string>()
  const visit = (file: string) => {
    if (seen.has(file) || !fs.existsSync(file)) return
    seen.add(file)
    const json = readJson(file)
    if (!json) return
    const dir = path.dirname(file)
    const ext = json.extends
    for (const e of Array.isArray(ext) ? ext : ext ? [ext] : []) if (typeof e === 'string' && e.startsWith('.')) visit(path.resolve(dir, e.endsWith('.json') ? e : e + '.json'))
    const co = (json.compilerOptions ?? {}) as { paths?: Record<string, string[]>; baseUrl?: string }
    const base = co.baseUrl ? path.resolve(dir, co.baseUrl) : dir
    for (const [key, targets] of Object.entries(co.paths ?? {})) {
      const t = targets?.[0]
      if (!t) continue
      const abs = toPosix(path.relative(root, path.resolve(base, t.replace(/\/\*$/, ''))))
      out[key.replace(/\/\*$/, '')] = normDir(abs)
    }
    for (const r of (json.references ?? []) as { path: string }[]) {
      const p = path.resolve(dir, r.path)
      visit(fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'tsconfig.json') : p)
    }
  }
  visit(path.join(root, 'tsconfig.json'))
  for (const f of ['tsconfig.app.json', 'jsconfig.json']) visit(path.join(root, f))
  return out
}

const CONFIG_FILES = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cts', 'vite.config.cjs']

/** `resolve.alias` of the vite.config, read statically; `tsconfigPaths` says Vite takes the tsconfig paths. */
export function viteAliases(root: string): { file: string | null; aliases: Record<string, string>; tsconfigPaths: boolean } {
  const file = CONFIG_FILES.map((f) => path.join(root, f)).find((f) => fs.existsSync(f)) ?? null
  if (!file) return { file: null, aliases: {}, tsconfigPaths: false }
  const text = fs.readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const aliases: Record<string, string> = {}
  const target = (e: ts.Expression): string | null => {
    const strings = stringsIn(e).filter((s) => s !== 'import.meta.url')
    const s = strings[strings.length - 1]
    return s === undefined ? null : normDir(s)
  }
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && n.name.getText(sf).replace(/['"]/g, '') === 'alias') {
      const init = n.initializer
      if (ts.isObjectLiteralExpression(init)) {
        for (const p of init.properties) {
          if (!ts.isPropertyAssignment(p)) continue
          const t = target(p.initializer)
          if (t !== null) aliases[p.name.getText(sf).replace(/^['"]|['"]$/g, '')] = t
        }
      } else if (ts.isArrayLiteralExpression(init)) {
        for (const el of init.elements) {
          if (!ts.isObjectLiteralExpression(el)) continue
          const find = el.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'find')
          const rep = el.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'replacement')
          if (find && rep && ts.isStringLiteralLike(find.initializer)) {
            const t = target(rep.initializer)
            if (t !== null) aliases[find.initializer.text] = t
          }
        }
      }
    }
    n.forEachChild(visit)
  }
  sf.forEachChild(visit)
  const tsconfigPaths = /tsconfigPaths\s*:\s*true|vite-tsconfig-paths/.test(text)
  return { file: toPosix(path.relative(root, file)), aliases, tsconfigPaths }
}

function packageJson(root: string): { deps: Record<string, string> } {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    return { deps: { ...j.devDependencies, ...j.dependencies } }
  } catch {
    return { deps: {} }
  }
}

const major = (v: string | undefined): number | null => {
  const m = v ? /(\d+)/.exec(v.replace(/^[^\d]*/, '')) : null
  return m ? Number(m[1]) : null
}

export function detectCss(root: string, project?: Project): SuggestPlan['css'] {
  const { deps } = packageJson(root)
  const v4 = major(deps.tailwindcss) === 4 || Boolean(deps['@tailwindcss/vite']) || Boolean(deps['@tailwindcss/postcss'])
  const cssFiles = globSync(['src/**/*.css'], { cwd: root, ignore: ['**/node_modules/**'], onlyFiles: true }).map(toPosix).sort()
  const entries = cssFiles.filter((f) => /@import\s+(url\()?\s*["']tailwindcss["']/.test(fs.readFileSync(path.join(root, f), 'utf8')))
  if (v4 && entries.length) {
    // the entry the app imports from its main file, else the shortest path
    const imported = project ? entries.find((e) => [...project.mods.values()].some((m) => /(^|\/)(main|index|App)\.[jt]sx?$/.test(m.path) && m.imports.some((i) => i.file === e))) : undefined
    const entry = imported ?? [...entries].sort((a, b) => a.length - b.length)[0]!
    return { mode: 'tailwind', tailwindEntry: entry }
  }
  if (v4) return { mode: 'palette', note: 'Tailwind 4 is installed but no CSS file under src has @import "tailwindcss": add it to the entry CSS, then css: \'tailwind\' with tailwindEntry' }
  if (deps.tailwindcss) return { mode: 'palette', note: `Tailwind ${major(deps.tailwindcss) ?? '?'} is not supported for runtime CSS (needs Tailwind 4): 'palette' mode; pre-generate the classes edits may use with @source inline(...)` }
  return { mode: 'palette' }
}

// --- the UI kit ---

function detectKit(project: Project): SuggestPlan['kit'] {
  for (const dir of ['src/components/ui', 'src/ui', 'src/shared/ui', 'src/components/ui-kit', 'src/design-system', 'src/components/base']) {
    const files = project.files.filter((f) => f.startsWith(dir + '/') && SCRIPT_RE.test(f) && !isTest(f))
    if (files.length < 2) continue
    const direct = files.filter((f) => !f.slice(dir.length + 1).includes('/'))
    const subdirs = new Set(files.filter((f) => f.slice(dir.length + 1).includes('/')).map((f) => f.slice(dir.length + 1).split('/')[0]))
    const clean = project.files.filter((f) => f.startsWith(dir + '/')).every((f) => SCRIPT_RE.test(f) && !isTest(f)) && !globSync([`${dir}/**/*.{css,scss,less,mdx,snap}`], { cwd: project.root, ignore: ['**/node_modules/**'] }).length
    return { dir, layout: direct.length >= subdirs.size ? 'flat' : 'folders', clean }
  }
  return null
}

// --- panels ---

interface PanelSet {
  choice: Required<PanelChoice>
  files: Set<string>
}

const ROUTER_HOOK_SETUP = /^(getRouteApi|createRoute|createFileRoute|createLazyFileRoute|createRootRoute)$/

/** Whether the page already has a setup line: the same import binding, or the same declaration. */
function pageHas(page: string, line: string): boolean {
  const imp = /^import \{ (?:\w+ as )?(\w+) \} from '([^']+)'$/.exec(line)
  if (imp) return new RegExp(`import\\s*(type\\s+)?\\{[^}]*\\b${imp[1]}\\b[^}]*\\}\\s*from\\s*['"]${escapeRe(imp[2]!)}['"]`).test(page)
  const norm = (x: string) => x.replace(/["'`]/g, "'").replace(/\s+/g, '')
  return norm(page).includes(norm(line))
}

function routeLike(p: string): boolean {
  return /(^|\/)(routes|pages|views|screens)\//.test(p)
}

/** Files that are pages: in a routes/pages folder, or rendered by a route table. */
function findPages(project: Project): Set<string> {
  const pages = new Set<string>()
  for (const m of project.mods.values()) {
    if (isTest(m.path) || !m.script) continue
    if (routeLike(m.path) && m.jsxCount + m.routeRefs.size > 0) pages.add(m.path)
  }
  // a file of a pages folder that another page renders is a component of that page (pages/dashboards/StatCards.tsx)
  const rendered = new Set<string>()
  for (const page of pages) {
    const m = project.mod(page)!
    for (const j of m.jsx) {
      const t = project.bindingTarget(m, j.tag.split('.')[0]!)
      if (t?.target && t.target[0] !== page && !project.mod(t.target[0])?.isRouteTable) rendered.add(t.target[0])
    }
  }
  for (const r of rendered) if (!/(^|\/)routes\//.test(r)) pages.delete(r)
  for (const m of project.mods.values()) {
    if (isTest(m.path) || !m.isRouteTable) continue
    const refs = m.routeRefs
    for (const local of refs) {
      const t = project.bindingTarget(m, local)
      if (t?.target && !t.imp.pkg) pages.add(t.target[0])
    }
    for (const i of m.imports) if (i.file && i.bindings.length && !i.reexport && m.isRouteTable && i.spec && /lazy|import\(/.test(i.text)) pages.add(i.file)
  }
  return pages
}

function defaultComponent(project: Project, file: string, wanted?: string): string {
  const m = project.mod(file)
  if (!m) return wanted ?? 'default'
  if (wanted) return wanted
  const exported = [...m.localExports.keys(), ...m.reexports.keys()]
  if (m.localExports.has('default')) return 'default'
  const base = pascal(path.posix.basename(file).replace(/\.[^.]+$/, '') === 'index' ? path.posix.basename(path.posix.dirname(file)) : path.posix.basename(file))
  const named = exported.find((e) => e.toLowerCase() === base.toLowerCase()) ?? exported.find((e) => /^[A-Z]/.test(e))
  return named ?? 'default'
}

function panelId(file: string, component: string, project: Project): string {
  const base = path.posix.basename(file).replace(/\.[^.]+$/, '')
  const m = project.mod(file)
  // a file with several components: the one rendered gives the id
  const components = m ? [...m.localExports.keys()].filter((k) => /^[A-Z]/.test(k)) : []
  if (component !== 'default' && components.length > 1 && kebab(component) !== kebab(base)) return kebab(component)
  if (base !== 'index') return kebab(base)
  const local = component === 'default' ? m?.localExports.get('default') : component
  return kebab(local && local !== 'default' ? local : path.posix.basename(path.posix.dirname(file)))
}

const panelsOf = (chosen: Required<PanelChoice>[]): string[] => chosen.map((c) => c.file)

/** Other components of the panel's file that files outside the panels import (the file cannot move whole). */
function sharedFile(project: Project, file: string, component: string, panelFiles: string[]): string[] {
  const m = project.mod(file)
  if (!m) return []
  const own = component === 'default' ? (m.localExports.get('default') ?? 'default') : component
  const out = new Set<string>()
  for (const importer of project.importers.get(file) ?? []) {
    if (panelFiles.includes(importer)) continue
    const im = project.mod(importer)!
    for (const i of im.imports) {
      if (i.file !== file) continue
      for (const b of i.bindings) {
        const name = b.imported === 'default' ? (m.localExports.get('default') ?? 'default') : b.imported
        if (!b.type && name !== own && name !== component && /^[A-Z]/.test(name) && im.jsx.some((j) => j.tag === b.local)) out.add(name)
      }
    }
  }
  return [...out].sort()
}

/** Pages that render several data components of the kit inline (stat tiles, cards): a panel once extracted. */
function inlineBlocks(project: Project, pages: Set<string>, kit: SuggestPlan['kit']): string[] {
  const out: string[] = []
  for (const page of [...pages].sort()) {
    const m = project.mod(page)
    if (!m || !kit) continue
    const counts = new Map<string, number>()
    for (const j of m.jsx) {
      const t = project.bindingTarget(m, j.tag.split('.')[0]!)
      if (!t?.target || !t.target[0].startsWith(kit.dir + '/') || !/^(StatTile|Stat|Statistic|Metric|Kpi)\w*$/.test(j.tag)) continue
      counts.set(j.tag, (counts.get(j.tag) ?? 0) + 1)
    }
    for (const [tag, n] of counts) if (n >= 3) out.push(`${page} renders ${n} <${tag}> inline: extract them into a component (e.g. src/components/${kebab(path.posix.basename(page).replace(/\.[^.]+$/, '').replace(/Page$/, ''))}-stats.tsx) to make them a panel`)
  }
  return out
}

/** Hooks of the router (and the route objects) that the panel calls: they stay in the page and come in as props. */
function routerHooks(project: Project, m: Mod): { hooks: HookProp[]; dropped: Set<string> } {
  const hooks: HookProp[] = []
  const dropped = new Set<string>()
  const sf = m.sf
  if (!sf) return { hooks, dropped }
  const fromRouter = new Map<string, Binding>()
  const routeObjects = new Map<string, string[]>() // local var → setup lines
  const importLine = (local: string): string => {
    const imp = m.imports.find((i) => i.bindings.some((b) => b.local === local))
    const b = imp?.bindings.find((x) => x.local === local)
    return imp && b ? `import { ${b.imported === local ? local : `${b.imported} as ${local}`} } from '${imp.spec}'` : ''
  }
  for (const imp of m.imports) {
    for (const b of imp.bindings) {
      if (b.type) continue
      if (imp.pkg && ROUTER_PACKAGES.has(imp.pkg)) fromRouter.set(b.local, b)
      // `import { Route } from '@/routes/…'` (TanStack file routes)
      if (imp.file && routeLike(imp.file) && /^Route$/.test(b.imported)) routeObjects.set(b.local, [`import { ${b.imported === b.local ? b.local : `${b.imported} as ${b.local}`} } from '${imp.spec}'`])
    }
  }
  const visitDecl = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer)) {
      const callee = n.initializer.expression.getText(sf)
      if (fromRouter.has(callee) && ROUTER_HOOK_SETUP.test(fromRouter.get(callee)!.imported)) routeObjects.set(n.name.text, [importLine(callee), `const ${n.getText(sf)}`])
    }
    n.forEachChild(visitDecl)
  }
  sf.forEachChild(visitDecl)
  const propName = (call: ts.CallExpression, hook: string): string[] => {
    const p = call.parent
    if (p && ts.isVariableDeclaration(p)) {
      if (ts.isIdentifier(p.name)) return [p.name.text]
      if (ts.isObjectBindingPattern(p.name)) return p.name.elements.map((e) => e.name.getText(sf))
      if (ts.isArrayBindingPattern(p.name)) return p.name.elements.filter(ts.isBindingElement).map((e) => e.name.getText(sf))
    }
    if (p && ts.isPropertyAssignment(p)) return [p.name.getText(sf)]
    const bare = hook.replace(/^use/, '')
    return [bare[0]!.toLowerCase() + bare.slice(1)]
  }
  const usedObjects = new Set<string>()
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const e = n.expression
      let hook: string | null = null
      let setup: string[] = []
      if (ts.isIdentifier(e) && fromRouter.has(e.text) && /^use[A-Z]/.test(fromRouter.get(e.text)!.imported)) {
        hook = fromRouter.get(e.text)!.imported
        dropped.add(e.text)
        setup = [importLine(e.text)]
      } else if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && routeObjects.has(e.expression.text) && /^use[A-Z]/.test(e.name.text)) {
        hook = e.name.text
        setup = routeObjects.get(e.expression.text) ?? []
        usedObjects.add(e.expression.text)
      }
      if (hook) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
        for (const prop of propName(n, hook)) hooks.push({ prop, hook: n.getText(sf), setup, file: m.path, line })
      }
    }
    n.forEachChild(visit)
  }
  sf.forEachChild(visit)
  // getRouteApi / createRoute bindings whose only use was a route object that moved out
  for (const [local, b] of fromRouter) {
    if (!ROUTER_HOOK_SETUP.test(b.imported)) continue
    const uses = (m.source.match(new RegExp(`\\b${local}\\b`, 'g')) ?? []).length
    const objects = [...routeObjects.entries()].filter(([o, text]) => usedObjects.has(o) && text.join(' ').includes(local)).length
    if (objects > 0 && uses <= objects + 1) dropped.add(local)
  }
  return { hooks, dropped }
}

/** Relative modules only the panel uses but which hold app state or open dialogs: they stay in core. */
function statefulReason(project: Project, file: string, panelFiles: Set<string>): string | null {
  const m = project.mod(file)
  if (!m) return null
  const base = path.posix.basename(file)
  if (STATEFUL_NAME_RE.test(base)) return `${base} is a dialog, form, provider or store`
  for (const imp of m.imports) {
    if (!imp.file || imp.pkg) continue
    if (!(imp.spec.startsWith('.'))) continue
    const other = path.posix.basename(imp.file)
    if (STATEFUL_NAME_RE.test(other) && !panelFiles.has(imp.file)) return `it imports ${other} (a dialog, form, provider or store of the app)`
    for (const b of imp.bindings) {
      if (b.type || !/^use[A-Z]|Provider$|Context$/.test(b.imported)) continue
      const users = [...(project.importers.get(imp.file) ?? [])].filter((u) => !panelFiles.has(u) && u !== file)
      if (users.length) return `it calls ${b.imported} from ${imp.file}, which the rest of the app shares`
    }
  }
  return null
}

function isDomain(file: string): boolean {
  return DOMAIN_RE.test(file.replace(/^src\//, ''))
}

/** The files a module pulls in (other than the kit and packages), if small enough to put in the readonly zone whole. */
function selfContained(project: Project, entry: string, kitDir: string | null, panelFiles: Set<string>): string[] | null {
  if (isDomain(entry)) return null
  const files = new Set<string>()
  let lines = 0
  const stack = [entry]
  while (stack.length) {
    const f = stack.pop()!
    if (files.has(f)) continue
    if (f !== entry && isDomain(f)) return null
    if (panelFiles.has(f)) return null
    const m = project.mod(f)
    if (!m) continue
    files.add(f)
    lines += m.lines
    if (files.size > 20 || lines > 1500) return null
    for (const i of m.imports) {
      if (!i.file) continue
      if (kitDir && i.file.startsWith(kitDir + '/')) continue
      stack.push(i.file)
    }
  }
  // used elsewhere in the app too: a small re-export module instead (install.md step 5.2)
  for (const f of files) if ([...(project.importers.get(f) ?? [])].some((u) => !panelFiles.has(u) && !files.has(u))) return null
  return [...files].sort()
}

/** The export is a type (interface, type alias, or re-exported as a type): `export type { … }` under verbatimModuleSyntax. */
function isTypeExport(project: Project, file: string, name: string): boolean {
  const target = project.resolveExport(file, name)
  if (!target) return false
  const m = project.mod(target[0])
  if (!m?.sf) return false
  const local = m.localExports.get(target[1]) ?? target[1]
  let type = false
  let value = false
  for (const st of m.sf.statements) {
    if ((ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) && st.name.text === local) type = true
    else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name?.text === local) value = true
    else if (ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === local)) value = true
    else if (ts.isImportDeclaration(st) && st.importClause) {
      const c = st.importClause
      const els = c.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements : []
      const e = els.find((x) => x.name.text === local)
      if (e) {
        if (c.isTypeOnly || e.isTypeOnly) type = true
        else value = true
      }
    } else if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
      const e = st.exportClause.elements.find((x) => x.name.text === target[1])
      if (e && (st.isTypeOnly || e.isTypeOnly)) type = true
    }
  }
  return type && !value
}

/** A module that only re-exports others (`index.ts` with `export * from './a'`). */
function isBarrel(project: Project, file: string): boolean {
  const m = project.mod(file)
  if (!m?.sf) return false
  const own = m.sf.statements.filter((st) => !ts.isImportDeclaration(st) && !ts.isExportDeclaration(st))
  return own.length === 0 && new Set(m.imports.map((i) => i.file).filter(Boolean)).size >= 3
}

/** Every name a module exports, through its re-exports. */
function exportNames(project: Project, file: string, seen = new Set<string>()): Set<string> {
  const out = new Set<string>()
  if (seen.has(file)) return out
  seen.add(file)
  const m = project.mod(file)
  if (!m) return out
  for (const k of m.localExports.keys()) out.add(k)
  for (const k of m.reexports.keys()) out.add(k)
  // `import type { A } from './a'` + `export type { A }`
  for (const k of m.localExports.keys()) out.add(k)
  for (const st of m.stars) for (const k of exportNames(project, st, seen)) if (k !== 'default') out.add(k)
  return out
}

function groupOf(file: string): string {
  const p = file.replace(/^src\//, '')
  const m = /^(?:features?|modules|pages|views|screens|routes|app)\/([^/]+)/.exec(p)
  if (m) return kebab(m[1]!)
  // shared modules: one re-export module per kind
  const top = p.split('/')[0]!
  if (/^types?$/.test(top)) return 'types'
  if (/^hooks?$/.test(top) || /(^|\/)use[A-Z][^/]*$/.test(stripExt(p))) return 'hooks'
  if (/^(utils?|helpers?|lib)$/.test(top)) return 'utils'
  if (top === 'components') return 'components'
  const parts = stripExt(p).split('/')
  const last = parts[parts.length - 1]!
  return kebab(last === 'index' ? (parts[parts.length - 2] ?? 'app') : last).replace(/^use-/, '') || 'app'
}

// --- the plan ---

export function suggest(options: SuggestOptions): SuggestPlan {
  const root = path.resolve(options.root)
  const vite = viteAliases(root)
  const tsc = tsconfigAliases(root)
  const viteAll = vite.tsconfigPaths ? { ...tsc, ...vite.aliases } : vite.aliases
  const todo: string[] = []
  const aliases = { ...tsc, ...viteAll }
  const at = aliases['@'] ?? null
  if (viteAll['@'] !== 'src') todo.push(at && at !== 'src' ? `'@' resolves to ${at}, not src: pass alias: { '@': '${at}' } to the plugin or add '@' → src` : `vite.config: add resolve.alias { '@': fileURLToPath(new URL('./src', import.meta.url)) } (install.md step 3)`)
  if (tsc['@'] !== 'src') todo.push(`tsconfig: add "paths": { "@/*": ["./src/*"] } (install.md step 4)`)
  // the plan writes '@/…' specifiers: resolve them as the installed app will
  const project = new Project(root, { ...aliases, '@': at ?? 'src' })
  const kit = detectKit(project)
  const css = detectCss(root, project)
  const pages = findPages(project)
  const notes: string[] = []

  // 1. which panels
  const candidates = rankCandidates(project, pages, kit)
  notes.push(...inlineBlocks(project, pages, kit))
  let chosen: Required<PanelChoice>[]
  let mode: SuggestPlan['mode']
  if (options.panels?.length) {
    mode = 'panels'
    chosen = options.panels.map((c) => {
      const file = toPosix(path.relative(root, path.resolve(root, c.file)))
      if (!project.mod(file)) throw new Error(`--panels: ${c.file} is not a source file under src/ of ${root}`)
      const component = defaultComponent(project, file, c.component)
      const others = sharedFile(project, file, component, options.panels!.map((x) => toPosix(path.relative(root, path.resolve(root, x.file)))))
      if (others.length) notes.push(`${file} also exports ${others.join(', ')}, which other files render: move ${component === 'default' ? 'the panel' : component} into its own file first (or name that file in --panels)`)
      return { file, component, id: c.id ?? panelId(file, component, project) }
    })
  } else {
    mode = 'heuristic'
    const max = options.maxPanels ?? 5
    const perPage = new Map<string, number>()
    chosen = []
    for (const c of candidates) {
      if (chosen.length >= max || c.score < 5) break
      const page = c.pages[0] ?? ''
      if ((perPage.get(page) ?? 0) >= 3) continue
      if (perPage.size >= 3 && !perPage.has(page)) continue
      perPage.set(page, (perPage.get(page) ?? 0) + 1)
      if (chosen.some((x) => x.file === c.file)) continue
      if (sharedFile(project, c.file, c.component, panelsOf(chosen)).length) continue
      chosen.push({ file: c.file, component: c.component, id: panelId(c.file, c.component, project) })
    }
  }
  const ids = new Set<string>()
  for (const c of chosen) {
    if (ids.has(c.id)) throw new Error(`two panels would get the id "${c.id}": name one with --panels <file>:<id>`)
    ids.add(c.id)
  }

  // 2. move or copy: a file other modules import too (a story, a test, a barrel) is copied, the original stays
  const actions = new Map<string, { action: 'move' | 'copy'; otherUsers: string[] }>()
  for (const c of chosen) {
    const comp = project.resolveExport(c.file, c.component)
    const renderers = new Set<string>()
    for (const m of project.mods.values()) {
      if (m.path === c.file || !m.script || isTest(m.path)) continue
      for (const j of m.jsx) {
        const t = project.bindingTarget(m, j.tag.split('.')[0]!)
        if (t?.target && comp && t.target[0] === comp[0] && t.target[1] === comp[1]) renderers.add(m.path)
      }
      if ([...m.routeRefs].some((r) => {
        const t = project.bindingTarget(m, r)
        return Boolean(t?.target && comp && t.target[0] === comp[0] && t.target[1] === comp[1])
      })) renderers.add(m.path)
    }
    const others = [...new Set([...(project.importers.get(c.file) ?? []), ...(project.testImporters.get(c.file) ?? [])])].filter((u) => !renderers.has(u) && !chosen.some((o) => o.file === u)).sort()
    actions.set(c.id, { action: others.length ? 'copy' : 'move', otherUsers: others })
  }

  // what moves with each panel: relative helpers only the panel set imports
  const stays = new Map<string, { file: string; reason: string }[]>()
  const sets: PanelSet[] = chosen.map((choice) => ({ choice, files: new Set([choice.file]) }))
  const allPanelFiles = () => new Set(sets.flatMap((s) => [...s.files]))
  const keptInCore = new Map<string, { file: string; reason: string }[]>()
  const isKit = (f: string) => Boolean(kit && f.startsWith(kit.dir + '/'))
  for (let changed = true; changed; ) {
    changed = false
    for (const s of sets) {
      for (const f of [...s.files]) {
        for (const imp of project.mod(f)?.imports ?? []) {
          if (!imp.file || !imp.spec.startsWith('.') || !imp.file.startsWith(path.posix.dirname(s.choice.file) + '/') || s.files.has(imp.file) || isKit(imp.file) || pages.has(imp.file)) continue
          if (sets.some((o) => o.choice.file === imp.file)) continue
          const users = [...(project.importers.get(imp.file) ?? [])]
          const all = allPanelFiles()
          if (!users.every((u) => all.has(u))) continue
          const kept = keptInCore.get(s.choice.id) ?? []
          if (kept.some((k) => k.file === imp.file)) continue
          if (CSS_RE.test(imp.file) && !imp.file.endsWith('.module.css') && actions.get(s.choice.id)!.action === 'copy') {
            const st = stays.get(s.choice.id) ?? []
            if (!st.some((x) => x.file === imp.file)) st.push({ file: imp.file, reason: 'global stylesheet, still imported by the original' })
            stays.set(s.choice.id, st)
            continue
          }
          const reason = CSS_RE.test(imp.file) ? null : statefulReason(project, imp.file, s.files)
          if (reason) {
            kept.push({ file: imp.file, reason })
            keptInCore.set(s.choice.id, kept)
            continue
          }
          const file = imp.file
          if (sets.some((o) => o !== s && o.files.has(file))) continue
          s.files.add(file)
          changed = true
        }
      }
    }
  }
  const owner = new Map<string, PanelSet>()
  for (const s of sets) for (const f of s.files) owner.set(f, s)
  const panelFiles = allPanelFiles()

  // targets of moved files
  const targets = new Map<string, string>()
  const taken = new Set<string>()
  for (const s of sets) {
    targets.set(s.choice.file, `src/dynamic/${s.choice.id}.tsx`)
    taken.add(`src/dynamic/${s.choice.id}.tsx`)
  }
  for (const s of sets) {
    for (const f of s.files) {
      if (f === s.choice.file) continue
      const base = path.posix.basename(f)
      const ext = base.endsWith('.module.css') ? '.module.css' : path.posix.extname(base)
      let stem = base.slice(0, base.length - ext.length)
      if (/^(index|styles?|utils?|types?|constants?|data|helpers?|hooks?)$/i.test(stem)) stem = `${s.choice.id}-${stem}`
      let t = `src/dynamic/${stem}${ext}`
      if (taken.has(t)) t = `src/dynamic/${s.choice.id}-${stem}${ext}`
      taken.add(t)
      targets.set(f, t)
    }
  }

  // 3. what the moved files import from the app
  const reexports = new Map<string, { group: string; module: string; names: Map<string, ReexportName>; usedBy: Set<string> }>()
  const direct = new Map<string, { entry: string; files: string[]; usedBy: Set<string> }>()
  const kitFiles = new Set<string>()
  const npm = new Map<string, Set<string>>()
  const importRewrites: { panel: string; file: string; from: string; to: string; line: string }[] = []
  const hooksByPanel = new Map<string, { hooks: HookProp[]; dropped: Set<string> }>()
  // the names all moved files take from each app module
  const namesUsed = new Map<string, Set<string>>()
  for (const f of panelFiles) {
    for (const imp of project.mod(f)?.imports ?? []) {
      if (!imp.file) continue
      const set = namesUsed.get(imp.file) ?? new Set<string>()
      for (const b of imp.bindings) set.add(b.imported)
      namesUsed.set(imp.file, set)
    }
  }
  for (const s of sets) {
    const allHooks: HookProp[] = []
    for (const f of s.files) {
      const m = project.mod(f)
      if (!m) continue
      const { hooks, dropped } = routerHooks(project, m)
      allHooks.push(...hooks)
      for (const imp of m.imports) {
        const values = imp.bindings.filter((b) => !b.type && !dropped.has(b.local))
        if (imp.pkg) {
          if (imp.typeOnly || (imp.bindings.length > 0 && values.length === 0)) continue
          if (DEFAULT_EXTERNALS.includes(imp.spec) || imp.spec === 'react') continue
          if (CSS_RE.test(imp.spec)) {
            notes.push(`${f} imports the stylesheet ${imp.spec}: import it once from the app's entry instead (dynamic files cannot import package CSS)`)
            continue
          }
          if (!npm.has(imp.spec)) npm.set(imp.spec, new Set())
          npm.get(imp.spec)!.add(s.choice.id)
          continue
        }
        if (!imp.file) {
          if (imp.asset) notes.push(`${f}:${imp.line} imports the asset ${imp.spec}: serve it from public/ and refer to it by URL, or re-export it from a readonly module`)
          continue
        }
        if (stays.get(s.choice.id)?.some((x) => x.file === imp.file)) {
          importRewrites.push({ panel: s.choice.id, file: f, from: imp.spec, to: '', line: `(remove) ${imp.text}: the global stylesheet stays with the original, which the app still loads` })
          continue
        }
        const target = targets.get(imp.file)
        if (target) {
          let rel = path.posix.relative(path.posix.dirname(targets.get(f)!), stripExt(target))
          if (target.endsWith('.css')) rel = path.posix.relative(path.posix.dirname(targets.get(f)!), target)
          if (!rel.startsWith('.')) rel = './' + rel
          if (rel !== imp.spec) importRewrites.push({ panel: s.choice.id, file: f, from: imp.spec, to: rel, line: imp.text.replace(imp.spec, rel) })
          continue
        }
        if (isKit(imp.file) && kit!.clean) {
          kitFiles.add(imp.file)
          // kit modules that are folders with an index, or barrels, keep their folder spec
          const spec = project.aliasSpec(imp.file)!
          if (spec !== imp.spec) importRewrites.push({ panel: s.choice.id, file: f, from: imp.spec, to: spec, line: imp.text.replace(imp.spec, spec) })
          continue
        }
        // a barrel the panel takes a few names from (`import { Order } from '@/types'`): re-export those names, not the folder
        const fewOfBarrel = isBarrel(project, imp.file) && (namesUsed.get(imp.file)?.size ?? 0) < exportNames(project, imp.file).size / 2
        const closure = fewOfBarrel || isKit(imp.file) || keptInCore.get(s.choice.id)?.some((k) => k.file === imp.file) ? null : selfContained(project, imp.file, kit?.dir ?? null, panelFiles)
        if (closure && !CSS_RE.test(imp.file)) {
          const d = direct.get(imp.file) ?? { entry: imp.file, files: closure, usedBy: new Set<string>() }
          d.usedBy.add(s.choice.id)
          direct.set(imp.file, d)
          const spec = project.aliasSpec(imp.file)!
          if (spec !== imp.spec) importRewrites.push({ panel: s.choice.id, file: f, from: imp.spec, to: spec, line: imp.text.replace(imp.spec, spec) })
          continue
        }
        if (CSS_RE.test(imp.file)) {
          notes.push(`${f} imports ${imp.file}, which other files use too: keep that stylesheet imported by the app (the panel's classes still apply)`)
          continue
        }
        // a re-export module: exactly the names the panel uses, from the module that declares them (through barrels,
        // so two panels that reach one component by two paths share one re-export)
        const ns = imp.bindings.find((b) => b.imported === '*' && !dropped.has(b.local))
        const entries: { module: string; name: string; local: string; type: boolean }[] = []
        if (ns) {
          for (const mem of new Set([...m.source.matchAll(new RegExp(`\\b${ns.local}\\.(\\w+)`, 'g'))].map((x) => x[1]!))) entries.push({ module: imp.file, name: mem, local: mem, type: ns.type })
        }
        for (const b of imp.bindings) {
          if (b.imported === '*' || dropped.has(b.local)) continue
          const decl = project.resolveExport(imp.file, b.imported)
          const via = decl && decl[0] !== imp.file && project.mod(decl[0]) ? decl : null
          entries.push({ module: via ? via[0] : imp.file, name: via ? via[1] : b.imported, local: b.local, type: b.type || isTypeExport(project, imp.file, b.imported) })
        }
        const items = new Map<string, string[]>() // group → the import's names
        for (const e of entries) {
          const r = reexports.get(e.module) ?? { group: isKit(e.module) ? 'ui' : groupOf(e.module), module: e.module, names: new Map<string, ReexportName>(), usedBy: new Set<string>() }
          r.usedBy.add(s.choice.id)
          const prev = r.names.get(e.name)
          r.names.set(e.name, { name: e.name, ...(e.name === 'default' ? { as: prev?.as ?? pascal(e.local) } : {}), type: (prev ? prev.type : true) && e.type })
          reexports.set(e.module, r)
          const exported = e.name === 'default' ? r.names.get('default')!.as! : e.name
          const list = items.get(r.group) ?? []
          list.push(`${e.type && !imp.typeOnly ? 'type ' : ''}${exported === e.local ? exported : `${exported} as ${e.local}`}`)
          items.set(r.group, list)
        }
        if (ns) {
          const spec = `@/readonly/${isKit(imp.file) ? 'ui' : groupOf(imp.file)}`
          importRewrites.push({ panel: s.choice.id, file: f, from: imp.spec, to: spec, line: `import ${imp.typeOnly ? 'type ' : ''}* as ${ns.local} from '${spec}'` })
          continue
        }
        for (const [group, list] of items) {
          const spec = `@/readonly/${group}`
          importRewrites.push({ panel: s.choice.id, file: f, from: imp.spec, to: spec, line: `import ${imp.typeOnly ? 'type ' : ''}{ ${list.join(', ')} } from '${spec}'` })
        }
      }
    }
    hooksByPanel.set(s.choice.id, { hooks: allHooks, dropped: new Set() })
  }

  // readonly re-export modules, one per group (feature)
  const groups = new Map<string, { module: string; names: Map<string, ReexportName> }[]>()
  for (const r of reexports.values()) {
    if (!groups.has(r.group)) groups.set(r.group, [])
    groups.get(r.group)!.push({ module: r.module, names: r.names })
  }
  const readonlyModules: ReadonlyModulePlan[] = []
  for (const [group, mods] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const exportedNames = new Set<string>()
    const from = mods
      .sort((a, b) => a.module.localeCompare(b.module))
      .map((x) => {
        const names = [...x.names.values()].sort((a, b) => a.name.localeCompare(b.name))
        for (const n of names) {
          const out = n.as ?? n.name
          if (exportedNames.has(out)) n.as = pascal(path.posix.basename(stripExt(x.module))) + out
          exportedNames.add(n.as ?? n.name)
        }
        return { module: x.module, spec: project.aliasSpec(x.module) ?? x.module, names }
      })
    const usedBy = [...new Set([...reexports.values()].filter((r) => r.group === group).flatMap((r) => [...r.usedBy]))].sort()
    const lines = [`// What the ${usedBy.join(', ')} panel${usedBy.length > 1 ? 's' : ''} need${usedBy.length > 1 ? '' : 's'} from the app (readonly zone, imported as @/readonly/${group}).`]
    for (const f of from) {
      const values = f.names.filter((n) => !n.type)
      const types = f.names.filter((n) => n.type)
      const fmt = (n: ReexportName) => (n.as ? `${n.name} as ${n.as}` : n.name)
      if (values.length) lines.push(`export { ${values.map(fmt).join(', ')} } from '${f.spec}'`)
      if (types.length) lines.push(`export type { ${types.map(fmt).join(', ')} } from '${f.spec}'`)
    }
    readonlyModules.push({ path: `src/readonly/${group}.ts`, spec: `@/readonly/${group}`, from, usedBy, source: lines.join('\n') + '\n' })
  }
  // a renamed re-export changes the panel's import
  for (const rw of importRewrites) {
    const mod = readonlyModules.find((r) => r.spec === rw.to)
    if (!mod) continue
    for (const f of mod.from) for (const n of f.names) if (n.as && n.name !== 'default') rw.line = rw.line.replace(new RegExp(`\\b(type )?${n.name}\\b(?! as)`), `$1${n.as} as ${n.name}`)
  }

  // 4. render sites and props
  const panels: PanelPlan[] = sets.map((s) => {
    const { choice } = s
    const hooks = hooksByPanel.get(choice.id)!.hooks
    const sites: RenderSite[] = []
    for (const m of project.mods.values()) {
      if (isTest(m.path) || panelFiles.has(m.path) || !m.script) continue
      for (const j of m.jsx) {
        const local = j.tag.split('.')[0]!
        const t = project.bindingTarget(m, local)
        if (!t?.target) continue
        const [file, name] = t.target
        const comp = project.resolveExport(choice.file, choice.component)
        if (!comp || comp[0] !== file || comp[1] !== name || j.tag.includes('.')) continue
        const attributes = j.attributes.map((a) => a.name).filter((a) => a !== 'key')
        const hookNames = [...new Set(hooks.map((h) => h.prop))]
        const props = [...new Set([...attributes, ...hookNames])]
        const page = m.source
        const add: string[] = []
        for (const h of hooks) {
          // the page already has it (`const search = route.useSearch()`)
          const method = /\.?(use\w+)\(/.exec(h.hook)?.[1] ?? ''
          if (new RegExp(`\\b(const|let)\\s+(\\{[^}]*\\b${h.prop}\\b[^}]*\\}|${h.prop})\\s*=\\s*[\\w.]*${method}\\(`).test(page) || attributes.includes(h.prop)) continue
          for (const line of h.setup) if (!pageHas(page, line) && !add.includes(line)) add.push(line)
          add.push(`const ${h.prop} = ${h.hook}`)
        }
        const entries = props.map((p) => {
          const a = j.attributes.find((x) => x.name === p)
          if (!a) return p
          const v = a.value === null ? 'true' : a.value
          if (v === p) return p
          if (v.includes('\n') || v.length > 80) {
            const name = new RegExp(`\\b(const|let|var|function)\\s+${p}\\b`).test(page) ? `${p}Prop` : p
            add.push(`const ${name} = ${v}`)
            return name === p ? p : `${p}: ${name}`
          }
          return `${p}: ${v}`
        })
        const replacement = `<Dynamic id=${JSON.stringify(choice.id)}${entries.length ? ` props={{ ${entries.join(', ')} }}` : ''}${j.spread ? ' /* spread props: list them */' : ''} />`
        sites.push({ file: m.path, line: j.line, element: j.text.length > 140 ? j.text.slice(0, 137) + '…' : j.text, attributes, props, add: [...new Set(add)], replacement })
      }
    }
    if (!sites.length) notes.push(`${choice.file}: no file renders ${choice.component === 'default' ? 'its default export' : choice.component} with JSX; render it through <Dynamic id="${choice.id}"> where the app shows it`)
    const helpers = [...s.files]
      .filter((f) => f !== choice.file)
      .sort()
      .map((f) => {
        const others = sets.filter((o) => o !== s && [...o.files].some((x) => project.mod(x)?.imports.some((i) => i.file === f))).map((o) => o.choice.id)
        const copy = actions.get(choice.id)!.action === 'copy' || (project.testImporters.get(f)?.size ?? 0) > 0
        return { file: f, target: targets.get(f)!, action: copy ? ('copy' as const) : ('move' as const), ...(others.length ? { sharedWith: others } : {}) }
      })
    const alsoImportedBy = actions.get(choice.id)!.action === 'copy' ? [] : [...new Set([...s.files].flatMap((f) => [...(project.testImporters.get(f) ?? [])]))].sort()
    const props = [...new Set(sites.flatMap((x) => x.props))]
    if (!sites.length) props.push(...new Set(hooks.map((h) => h.prop)))
    return {
      id: choice.id,
      file: choice.file,
      component: choice.component,
      target: targets.get(choice.file)!,
      action: actions.get(choice.id)!.action,
      otherUsers: actions.get(choice.id)!.otherUsers,
      helpers,
      stays: stays.get(choice.id) ?? [],
      keptInCore: keptInCore.get(choice.id) ?? [],
      hookProps: hooks,
      renderSites: sites,
      props,
      imports: mergeImports(importRewrites.filter((r) => r.panel === choice.id)),
      alsoImportedBy,
      ...(mode === 'heuristic' ? { reasons: candidates.find((c) => c.file === choice.file)?.reasons ?? [] } : {}),
    }
  })

  // 5. externals
  const externals: string[] = [...DEFAULT_EXTERNALS]
  const externalReasons: Record<string, string> = { react: 'always', 'react-dom': 'always', 'react/jsx-runtime': 'always' }
  const add = (spec: string, why: string) => {
    if (externals.includes(spec)) return
    externals.push(spec)
    externalReasons[spec] = why
  }
  if (readonlyModules.length) add('@/readonly/*', `the readonly re-export modules (${readonlyModules.map((r) => r.path).join(', ')})`)
  if (kit && kitFiles.size) {
    if (kit.layout === 'flat') {
      const flat = [...kitFiles].filter((f) => !f.slice(kit.dir.length + 1).includes('/'))
      if (flat.length) add(`${project.aliasSpec(kit.dir)}/*`, `the UI kit (one file per component directly in ${kit.dir}/; a trailing * matches those files)`)
      for (const f of [...kitFiles].filter((x) => !flat.includes(x)).sort()) add(project.aliasSpec(f)!, `UI kit module in a subfolder of ${kit.dir}`)
    } else {
      for (const f of [...kitFiles].sort()) add(project.aliasSpec(f)!, /\/index\.[jt]sx?$/.test(f) ? `UI kit folder with an index (${f})` : `UI kit, one folder per component (${f})`)
    }
  }
  for (const d of [...direct.values()].sort((a, b) => a.entry.localeCompare(b.entry))) add(project.aliasSpec(d.entry)!, `readonly as it is (${d.files.length} file${d.files.length > 1 ? 's' : ''}, used by ${[...d.usedBy].join(', ')})`)
  for (const [spec, by] of [...npm].sort((a, b) => a[0].localeCompare(b[0]))) add(spec, `package imported by ${[...by].join(', ')}`)
  const { deps } = packageJson(root)
  if (panels.length) for (const icons of ICON_PACKAGES) if (deps[icons]) add(icons, 'the app\'s icon set (lazy: loads only when an edit uses it)')

  // 6. zones
  const readonlyFiles = [...new Set([...kitFiles, ...[...direct.values()].flatMap((d) => d.files)])].filter((f) => !panelFiles.has(f)).sort()
  const readonlyZone: string[] = []
  if (readonlyModules.length) readonlyZone.push('src/readonly/**')
  readonlyZone.push(...compactGlobs(project, readonlyFiles, kit))

  // 7. core
  const zoneFiles = new Set([...panelFiles, ...readonlyFiles])
  const coreTypes = new Set<string>()
  for (const f of [...readonlyFiles, ...panelFiles]) for (const i of project.mod(f)?.imports ?? []) if (i.file && !zoneFiles.has(i.file) && !CSS_RE.test(i.file) && !targets.has(i.file)) coreTypes.add(i.file)
  for (const r of readonlyModules) for (const f of r.from) coreTypes.add(f.module)
  const coreCount = project.files.filter((f) => SCRIPT_RE.test(f) && !isTest(f) && !zoneFiles.has(f)).length

  const designSystem = kit && (kitFiles.size || [...reexports.keys()].some(isKit)) ? { components: [`${project.aliasSpec(kit.dir)}/*`] } : null
  const dynamicFiles = [...targets.values()].sort()
  const plan: SuggestPlan = {
    root,
    mode,
    alias: { at, vite: viteAll, tsconfig: tsc, todo },
    panels,
    readonlyModules,
    readonlyFiles,
    readonlyDirect: [
      ...[...kitFiles].sort().map((f) => ({ module: f, spec: project.aliasSpec(f)!, files: [f], kit: true })),
      ...[...direct.values()].sort((a, b) => a.entry.localeCompare(b.entry)).map((d) => ({ module: d.entry, spec: project.aliasSpec(d.entry)!, files: d.files, kit: false })),
    ],
    readonlyZone,
    externals,
    externalReasons,
    css,
    kit,
    designSystem,
    core: { count: coreCount, types: [...coreTypes].sort() },
    plugin: '',
    manifest: { panels: panels.map((p) => p.id), dynamic: dynamicFiles, readonly: [...readonlyModules.map((r) => r.path), ...readonlyFiles].sort() },
    notes: [...new Set(notes)],
    candidates,
  }
  plan.plugin = pluginBlock(plan)
  return plan
}

/** One import line per file and new specifier: `import { roles, type User, DataTableBulkActions } from '@/readonly/users'`. */
function mergeImports(rows: { file: string; from: string; to: string; line: string }[]): PanelPlan['imports'] {
  const out: PanelPlan['imports'] = []
  for (const r of rows) {
    const prev = out.find((o) => o.file === r.file && o.to === r.to)
    const named = (l: string) => /^import (type )?\{ (.*) \} from/.exec(l)
    const a = prev && named(prev.line)
    const b = named(r.line)
    if (prev && a && b) {
      const items = (m: RegExpExecArray) => m[2]!.split(',').map((x) => (m[1] ? 'type ' : '') + x.trim()).filter(Boolean)
      const all = [...new Set([...items(a), ...items(b)])]
      const allTypes = all.every((x) => x.startsWith('type '))
      prev.line = `import ${allTypes ? 'type ' : ''}{ ${all.map((x) => (allTypes ? x.slice(5) : x)).join(', ')} } from '${r.to}'`
      prev.from += `, ${r.from}`
      continue
    }
    out.push({ ...r })
  }
  return out.map(({ file, from, to, line }) => ({ file, from, to, line }))
}

/** Globs for the readonly zone: a folder whose files are all listed becomes `dir/**`, a flat kit a brace list. */
function compactGlobs(project: Project, files: string[], kit: SuggestPlan['kit']): string[] {
  const out: string[] = []
  const byDir = new Map<string, string[]>()
  for (const f of files) {
    const d = path.posix.dirname(f)
    if (!byDir.has(d)) byDir.set(d, [])
    byDir.get(d)!.push(f)
  }
  const done = new Set<string>()
  for (const [dir, list] of [...byDir].sort((a, b) => a[0].localeCompare(b[0]))) {
    const inDir = project.files.filter((f) => path.posix.dirname(f) === dir && (SCRIPT_RE.test(f) || CSS_RE.test(f)) && !isTest(f))
    const sub = project.files.filter((f) => f.startsWith(dir + '/') && path.posix.dirname(f) !== dir)
    const isKitRoot = kit && dir === kit.dir
    if (!isKitRoot && list.length > 1 && inDir.every((f) => list.includes(f)) && sub.every((f) => files.includes(f) || isTest(f) || !(SCRIPT_RE.test(f) || CSS_RE.test(f)))) {
      out.push(`${dir}/**`)
      for (const f of files) if (f.startsWith(dir + '/')) done.add(f)
      continue
    }
    const left = list.filter((f) => !done.has(f))
    const exts = new Set(left.map((f) => path.posix.extname(f)))
    if (left.length > 1 && exts.size === 1) out.push(`${dir}/{${left.map((f) => path.posix.basename(f, [...exts][0])).join(',')}}${[...exts][0]}`)
    else out.push(...left)
  }
  // a `dir/**` covers the lists of its subfolders
  return out.filter((g) => !out.some((o) => o !== g && o.endsWith('/**') && g.startsWith(o.slice(0, -2))))
}

function pluginBlock(plan: SuggestPlan): string {
  const q = (s: string) => `'${s}'`
  const lines = ['pleatkit({', '  zones: {', `    dynamic: ['src/dynamic/**'],`, `    readonly: [${plan.readonlyZone.map(q).join(', ')}],`, '  },', '  externals: [']
  for (const e of plan.externals) lines.push(`    ${q(e)},`)
  lines.push('  ],')
  lines.push(`  css: '${plan.css.mode}',${plan.css.tailwindEntry ? ` tailwindEntry: '${plan.css.tailwindEntry}',` : ''}`)
  if (plan.designSystem) lines.push(`  designSystem: { components: [${plan.designSystem.components.map(q).join(', ')}] },`)
  if (plan.alias.at && plan.alias.at !== 'src') lines.push(`  alias: { '@': '${plan.alias.at}' },`)
  lines.push('})')
  return lines.join('\n')
}

// --- the heuristic: which components are panels ---

const PANEL_NAME_RE = /(table|chart|graph|card|stats?|metrics?|kpi|tiles?|list|grid|orders|sales|revenue|overview|analytics|activity|summary|report|leaderboard|feed|timeline|board|widget|insights?|transactions?|invoices?|customers?|users|products?|tasks?)/i
const KIT_DATA_RE = /^(Table|DataTable|Card|StatTile|Statistic|List|Stat|Chart|Progress|Badge|Avatar)\w*$/

function rankCandidates(project: Project, pages: Set<string>, kit: SuggestPlan['kit']): Candidate[] {
  const scores = new Map<string, Candidate>()
  for (const page of pages) {
    const pm = project.mod(page)
    if (!pm) continue
    for (const j of pm.jsx) {
      const local = j.tag.split('.')[0]!
      if (!/^[A-Z]/.test(local) || j.tag.includes('.')) continue
      const t = project.bindingTarget(pm, local)
      if (!t?.target || t.imp.pkg) continue
      const [file, name] = t.target
      if (pages.has(file) || (kit && file.startsWith(kit.dir + '/')) || isTest(file) || routeLike(file) && /(^|\/)(routes)\//.test(file)) continue
      const m = project.mod(file)
      if (!m || !m.script) continue
      const localName = name === 'default' ? (m.localExports.get('default') ?? local) : name
      if (LAYOUT_RE.test(localName) || LAYOUT_RE.test(file)) continue
      const key = file + '#' + name
      const prev = scores.get(key)
      if (prev) {
        if (!prev.pages.includes(page)) prev.pages.push(page)
        continue
      }
      const reasons: string[] = []
      let score = 0
      const hit = (points: number, reason: string) => {
        score += points
        reasons.push(reason)
      }
      const pkgs = m.imports.filter((i) => i.pkg && !i.typeOnly).map((i) => i.spec)
      const chart = pkgs.find((p) => CHART_PACKAGES.test(p))
      const table = pkgs.find((p) => TABLE_PACKAGES.test(p))
      if (chart) hit(4, `chart (${chart})`)
      if (table) hit(4, `table (${table})`)
      const kitData = new Set<string>()
      for (const i of m.imports) {
        for (const b of i.bindings) {
          const used = b.imported === 'default' ? b.local : b.imported
          if (b.type || !KIT_DATA_RE.test(used) || /Props$/.test(used)) continue
          if ((i.file && kit && i.file.startsWith(kit.dir + '/')) || (i.pkg && /^(antd|@mui\/material|@mantine\/core|@chakra-ui\/react|react-bootstrap|@radix-ui\/themes)$/.test(i.pkg))) kitData.add(used)
        }
      }
      if (kitData.size) hit(Math.min(3, kitData.size + 1),`UI kit data components (${[...kitData].slice(0, 4).join(', ')})`)
      const base = path.posix.basename(file).replace(/\.[^.]+$/, '')
      const nameHit = PANEL_NAME_RE.exec(base === 'index' ? localName : base) ?? PANEL_NAME_RE.exec(localName)
      if (nameHit) hit(2, `name (${nameHit[0]})`)
      if (m.jsxCount >= 15) hit(1, `${m.jsxCount} JSX elements`)
      // stat tiles: a row of numbers with labels (no chart library)
      if (!chart && /(metric|stat|kpi|summary|tile|figure)/i.test(base === 'index' ? localName : base) && m.jsxCount >= 10) hit(2, 'stat tiles')
      if (/\.map\(\s*\(?\s*[\w{[]/.test(m.source) && m.jsxCount >= 5) hit(1, 'renders a list (.map)')
      if (/=\s*\[\s*\{[\s\S]{40,}?\}\s*,\s*\{/.test(m.source)) hit(1, 'has a data array')
      if (j.attributes.length) hit(1, `gets props (${j.attributes.map((a) => a.name).slice(0, 3).join(', ')})`)
      if (m.lines > 600) hit(-3, `large (${m.lines} lines)`)
      if (m.lines < 10) hit(-2, `small (${m.lines} lines)`)
      if (/useMutation|onSubmit=|<form\b|\.post\(|\.put\(|\.delete\(/.test(m.source)) hit(-3, 'writes data (form or mutation)')
      if (/(Dialog|Modal|Drawer)\b/.test(localName)) score -= 4
      scores.set(key, { file, component: name, score, reasons, pages: [page], line: j.line })
    }
  }
  return [...scores.values()].sort((a, b) => b.score - a.score || pageDepth(a) - pageDepth(b) || a.line - b.line || a.file.localeCompare(b.file))
}

const pageDepth = (c: Candidate): number => Math.min(...c.pages.map((p) => p.split('/').length + (/dashboard|home|overview|index/i.test(p) ? 0 : 1)))

// --- output ---

export function formatPlan(plan: SuggestPlan): string {
  const out: string[] = []
  const h = (s: string) => out.push('', s)
  out.push(`pleatkit init --suggest: ${plan.root}`)
  if (plan.mode === 'heuristic') {
    out.push(`Panels picked by a heuristic (panel choice is a product decision: name them with --panels <file>[:<id>],…). Ranked candidates:`)
    for (const c of plan.candidates.slice(0, 10)) out.push(`  ${String(c.score).padStart(3)}  ${c.file}${c.component !== 'default' ? `#${c.component}` : ''}  (${c.reasons.join('; ')})`)
  }
  if (plan.alias.todo.length) {
    h('Aliases (needed before the zones):')
    for (const t of plan.alias.todo) out.push(`  - ${t}`)
  }
  h(`1. Panels (dynamic zone), ${plan.panels.length}:`)
  for (const p of plan.panels) {
    out.push(`  ${p.id}: ${p.action} ${p.file}${p.component !== 'default' ? ` (${p.component})` : ''} → ${p.target}, as the default export${p.action === 'copy' ? ` (it has other users: ${p.otherUsers.join(', ')}; the original stays)` : ''}`)
    for (const hl of p.helpers) out.push(`    helper (${hl.action}): ${hl.file} → ${hl.target}${hl.sharedWith ? ` (also used by ${hl.sharedWith.join(', ')})` : ''}`)
    for (const st of p.stays) out.push(`    stays: ${st.file} (${st.reason})`)
    for (const k of p.keptInCore) out.push(`    stays in core, re-exported through readonly: ${k.file} (${k.reason})`)
    for (const hp of p.hookProps) out.push(`    router hook → prop "${hp.prop}": ${hp.hook} (${hp.file}:${hp.line})`)
    for (const s of p.renderSites) {
      out.push(`    render site ${s.file}:${s.line}: ${s.element}`)
      for (const a of s.add) out.push(`      add to the page: ${a.replace(/\n/g, '\n        ')}`)
      out.push(`      → ${s.replacement}`)
    }
    if (p.props.length) out.push(`    props: ${p.props.join(', ')}`)
    if (p.imports.length) {
      out.push(`    imports after the ${p.action}:`)
      for (const i of p.imports) out.push(`      ${i.file === p.file ? '' : `(${path.posix.basename(i.file)}) `}${i.line}`)
    }
    if (p.alsoImportedBy.length) out.push(`    tests/stories that import it (update their paths): ${p.alsoImportedBy.join(', ')}`)
    if (p.reasons?.length) out.push(`    why: ${p.reasons.join('; ')}`)
  }
  h(`2. Readonly zone: ${plan.readonlyModules.length} re-export module${plan.readonlyModules.length === 1 ? '' : 's'}, ${plan.readonlyFiles.length} app file${plan.readonlyFiles.length === 1 ? '' : 's'} as they are`)
  for (const r of plan.readonlyModules) {
    out.push(`  ${r.path}:`)
    for (const l of r.source.trimEnd().split('\n')) out.push(`    ${l}`)
  }
  if (plan.readonlyFiles.length) out.push(`  as they are: ${plan.readonlyFiles.join(', ')}`)
  h(`3. Core: ${plan.core.count} files stay as they are; the agent sees ${plan.core.types.length} of them as .d.ts:`)
  if (plan.core.types.length) out.push(`  ${plan.core.types.join(', ')}`)
  h('4. Externals:')
  for (const e of plan.externals) out.push(`  ${e.padEnd(40)} ${plan.externalReasons[e] ?? ''}`)
  h(`5. vite.config.ts, in plugins (css: ${plan.css.mode}${plan.css.note ? `; ${plan.css.note}` : ''}):`)
  for (const l of plan.plugin.split('\n')) out.push(`  ${l}`)
  h('The manifest it would produce:')
  out.push(`  panels: ${plan.manifest.panels.join(', ') || '(none)'}`)
  out.push(`  dynamic: ${plan.manifest.dynamic.join(', ') || '(none)'}`)
  out.push(`  readonly: ${plan.manifest.readonly.join(', ') || '(none)'}`)
  if (plan.notes.length) {
    h('Notes:')
    for (const n of plan.notes) out.push(`  - ${n}`)
  }
  return out.join('\n')
}

export interface WriteResult {
  created: string[]
  skipped: string[]
  notDone: string[]
}

/** `--write`: create the readonly re-export modules (new files only); everything that edits existing files is left to do. */
export function writePlan(plan: SuggestPlan): WriteResult {
  const created: string[] = []
  const skipped: string[] = []
  for (const r of plan.readonlyModules) {
    const abs = path.join(plan.root, r.path)
    if (fs.existsSync(abs)) {
      skipped.push(`${r.path} (exists; not overwritten)`)
      continue
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, r.source)
    created.push(r.path)
  }
  // stage 5 block 5 (found by a blind install): only what is still missing; the plugin block and the tsconfig types
  // may already be in place when suggest runs after steps 3 and 4
  const read = (rel: string) => {
    try {
      return fs.readFileSync(path.join(plan.root, rel), 'utf8')
    } catch {
      return ''
    }
  }
  const viteConfig = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'].map(read).join('\n')
  const tsconfigs = ['tsconfig.json', 'tsconfig.app.json'].map(read).join('\n')
  const notDone = [
    ...plan.alias.todo,
    ...plan.panels
      .filter((p) => !fs.existsSync(path.join(plan.root, p.target)))
      .map((p) => `${p.action} ${p.file}${p.helpers.length ? ` and ${p.helpers.length} helper${p.helpers.length > 1 ? 's' : ''}` : ''} to ${p.target} (default export, the imports above), and render it through <Dynamic id="${p.id}"> at ${p.renderSites.length} site${p.renderSites.length === 1 ? '' : 's'}`),
    ...(viteConfig.includes('@pleatkit/vite-plugin') ? [] : ['add the plugin block to vite.config.ts (install.md step 3)']),
    ...(tsconfigs.includes('@pleatkit/vite-plugin/client') ? [] : ['add the types to the tsconfig (install.md step 4)']),
  ]
  return { created, skipped, notDone }
}

/** `--panels a.tsx,b.tsx:my-id,c.tsx#Component:other-id` */
export function parsePanels(arg: string): PanelChoice[] {
  return arg
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      let file = s
      let id: string | undefined
      let component: string | undefined
      const idMatch = /:([a-z0-9][a-z0-9-]*)$/.exec(file)
      if (idMatch && !/^[a-zA-Z]:[\\/]/.test(file.slice(idMatch.index - 1))) {
        id = idMatch[1]
        file = file.slice(0, idMatch.index)
      }
      const hash = file.lastIndexOf('#')
      if (hash > 0) {
        component = file.slice(hash + 1)
        file = file.slice(0, hash)
      }
      return { file, ...(id ? { id } : {}), ...(component ? { component } : {}) }
    })
}
