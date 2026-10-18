import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import picomatch from 'picomatch'
import ts from 'typescript'
import { globSync } from 'tinyglobby'
import { validateZoneGlob } from '@pleatkit/runtime/compiler'
import { emitDeclarations } from './declarations.js'
import { tailwindInput } from './tailwind.js'

export interface ZonesOptions {
  /** Globs (relative to project root) the agent may edit; compiled at runtime. */
  dynamic: string[]
  /** Globs the agent may read but not edit. Everything else is core. */
  readonly?: string[]
}

export interface PleatkitOptions {
  zones: ZonesOptions
  /**
   * Module specifiers that dynamic code imports from the host app instead of bundling.
   * A trailing `*` is expanded against the file system, e.g. `@/components/ui/*`.
   */
  externals?: string[]
  /** Import aliases, specifier prefix → directory relative to root. Default `{ '@': 'src' }`. */
  alias?: Record<string, string>
  /** Emit `.d.ts` for core files that dynamic/readonly code imports. Default true. */
  coreTypes?: boolean
  /**
   * CSS for classes that runtime edits introduce.
   * - `tailwind`: compile Tailwind 4 in the browser at commit (needs `tailwindcss` installed in the app).
   * - `palette` (default): no runtime CSS; pre-generate a safelist with `@source inline(...)` in your CSS.
   */
  css?: 'palette' | 'tailwind'
  /** The app's Tailwind entry CSS; its `@theme`/`@utility`/`@custom-variant` blocks feed the runtime compiler. Default `src/index.css`. */
  tailwindEntry?: string
  /** Build the iframe host for `<Dynamic isolated>` panels. Default false. */
  isolated?: boolean
  /**
   * Where edits are compiled (V1 B1). `server` (default): on the agent server, signed, loaded from
   * `/pleatkit/b/…` with `import()`; the page needs neither WebAssembly nor `blob:`. `browser`: esbuild-wasm in
   * the page (falls back to the server by itself when WebAssembly cannot load).
   */
  compile?: 'server' | 'browser'
  /**
   * Public key of the app key (V1 A3, `npx pleatkit keys public`): when set, the runtime runs only bundles
   * signed with it. Default: the PLEATKIT_PUBLIC_KEY environment variable at build time.
   */
  publicKey?: string
  /** Register externals as `() => import()` so big libraries load only when an edit uses them (V1 B6). Default true. */
  lazyExternals?: boolean
  /**
   * Selectors of elements an edit must keep and must not hide (brainstorm 05 #20): `['[data-consent]', '.legal']`.
   * Checked by `check` in the browser and on the agent server. Attribute, class and id selectors.
   */
  protected?: string[]
  /**
   * Run every edited panel in the sandboxed iframe (code review 06 item 8). Default false: same realm (faster;
   * the static rules and the CSP are the boundary). Needs `isolated: true`.
   */
  isolateEdits?: boolean
  /** Send the visible text of a pointed panel to the agent (brainstorm 05 #3). Default false: structure only. */
  sendDomText?: boolean
  /**
   * Design-system profile for the agent (brainstorm 05 #10, 04 §1): the component modules whose `.d.ts` become a
   * one-line-per-component digest in the agent's prompt, and an optional markdown file with usage notes.
   * `{ components: ['@/components/ui/*'], docs: 'docs/design-system.md' }`.
   */
  designSystem?: { components?: string[]; docs?: string }
}

export interface ManifestFile {
  path: string
  source: string
}

export interface PleatkitManifest {
  version: 1
  dynamicRoots: string[]
  dynamic: ManifestFile[]
  readonly: ManifestFile[]
  coreTypes: ManifestFile[]
  externals: string[]
  externalPatterns: string[]
  alias: Record<string, string>
  /** Runtime CSS input for server compiles and its hash for bundle keys (V1 B1). */
  css?: { mode: 'tailwind' | 'palette'; input?: string; hash: string }
  /** Selectors of elements edits must keep visible (brainstorm 05 #20). */
  protected?: string[]
  /** Design-system digest for the agent, one line per component (brainstorm 05 #10). */
  designSystem?: { digest: string; docs?: string }
  /** Data contracts for the agent: types and client methods of the readonly zone (brainstorm 04 §1). */
  dataContracts?: { digest: string }
}

export const DEFAULT_EXTERNALS = ['react', 'react-dom', 'react/jsx-runtime']
const SOURCE_EXT = ['.tsx', '.ts', '.jsx', '.js', '.mts', '.mjs']
const RESOLVE_EXT = ['', ...SOURCE_EXT, '.css', ...SOURCE_EXT.map((e) => `/index${e}`)]
const IGNORE = ['**/node_modules/**', '**/dist/**', '**/*.d.ts']

export const toPosix = (p: string): string => p.split(path.sep).join('/')

/** Static directory prefix of a glob: `src/dynamic/**` → `src/dynamic/`. */
export function globRoot(glob: string): string {
  const parts = glob.split('/')
  const stat: string[] = []
  for (const part of parts) {
    if (/[*?{}[\]!]/.test(part)) break
    stat.push(part)
  }
  return stat.length === 0 ? '' : stat.join('/') + '/'
}

/**
 * Zone globs as written, normalized (`./src/dynamic/**` → `src/dynamic/**`, backslashes → slashes). A glob that
 * cannot work (absolute, outside the project, no fixed folder) is an error at startup instead of a zone that is
 * silently not editable (code review 06 item 11).
 */
export function normalizeZones(globs: string[], kind: 'dynamic' | 'readonly'): string[] {
  return globs.map((g) => {
    const { glob, problems } = validateZoneGlob(g)
    const fatal = problems.filter((p) => !p.includes('backslashes'))
    if (fatal.length) throw new Error(`[pleatkit] zones.${kind}: ${fatal.join('; ')}`)
    return glob
  })
}

export function resolveOptions(options: PleatkitOptions) {
  return {
    dynamic: normalizeZones(options.zones.dynamic, 'dynamic'),
    readonly: normalizeZones(options.zones.readonly ?? [], 'readonly'),
    externals: [...new Set([...DEFAULT_EXTERNALS, ...(options.externals ?? [])])],
    alias: options.alias ?? { '@': 'src' },
    coreTypes: options.coreTypes ?? true,
    css: options.css ?? 'palette',
    tailwindEntry: options.tailwindEntry ?? 'src/index.css',
    isolated: options.isolated ?? false,
    compile: options.compile ?? 'server',
    publicKey: options.publicKey ?? process.env.PLEATKIT_PUBLIC_KEY ?? null,
    lazyExternals: options.lazyExternals ?? true,
    protected: options.protected ?? [],
    isolateEdits: options.isolateEdits ?? false,
    sendDomText: options.sendDomText ?? false,
    designSystem: options.designSystem ?? null,
  }
}

function readFiles(root: string, globs: string[], exclude: string[] = []): ManifestFile[] {
  if (globs.length === 0) return []
  const files = globSync(globs, { cwd: root, ignore: [...IGNORE, ...exclude], onlyFiles: true })
  return files
    .map(toPosix)
    .sort()
    .map((p) => ({ path: p, source: fs.readFileSync(path.join(root, p), 'utf8') }))
}

/** Expand `@/components/ui/*` into one specifier per file found in that directory. */
export function expandExternals(root: string, patterns: string[], alias: Record<string, string>): string[] {
  const out = new Set<string>()
  for (const spec of patterns) {
    if (!spec.endsWith('*')) {
      out.add(spec)
      continue
    }
    const prefix = spec.slice(0, -1)
    const dir = aliasToPath(prefix, alias)
    if (dir === null) continue
    const files = globSync(SOURCE_EXT.map((e) => `${dir}*${e}`), { cwd: root, ignore: IGNORE })
    for (const f of files.map(toPosix).sort()) {
      const base = f.slice(dir.length).replace(/\.[^.]+$/, '')
      out.add(prefix + base)
    }
  }
  return [...out]
}

/** `@/lib/utils` → `src/lib/utils` (relative to root), or null for bare package specifiers. */
export function aliasToPath(spec: string, alias: Record<string, string>): string | null {
  for (const [key, dir] of Object.entries(alias)) {
    if (spec === key) return dir
    if (spec.startsWith(key + '/')) return dir.replace(/\/$/, '') + spec.slice(key.length)
  }
  return null
}

const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g

export function findImports(source: string): string[] {
  const out: string[] = []
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3]
    if (spec) out.push(spec)
  }
  return out
}

function resolveProjectFile(root: string, spec: string, importer: string, alias: Record<string, string>): string | null {
  let base: string | null
  if (spec.startsWith('./') || spec.startsWith('../')) base = path.posix.join(path.posix.dirname(importer), spec)
  else base = aliasToPath(spec, alias)
  if (base === null) return null
  for (const ext of RESOLVE_EXT) {
    const candidate = base + ext
    const abs = path.join(root, candidate)
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return toPosix(candidate)
  }
  return null
}

export function buildManifest(root: string, options: PleatkitOptions): PleatkitManifest {
  const o = resolveOptions(options)
  const dynamic = readFiles(root, o.dynamic)
  const readonly = readFiles(root, o.readonly, o.dynamic)
  if (dynamic.length === 0 && o.dynamic.length > 0) {
    console.warn(`[pleatkit] zones.dynamic (${o.dynamic.join(', ')}) matches no files under ${root}: nothing will be editable`)
  }
  const isDynamic = picomatch(o.dynamic)
  const isReadonly = picomatch(o.readonly)

  let coreTypes: ManifestFile[] = []
  if (o.coreTypes) {
    // Core files the agent will see through imports: emit only their declarations.
    const coreFiles = new Set<string>()
    for (const file of [...dynamic, ...readonly]) {
      for (const spec of findImports(file.source)) {
        const resolved = resolveProjectFile(root, spec, file.path, o.alias)
        if (resolved && !isDynamic(resolved) && !isReadonly(resolved) && !resolved.endsWith('.css')) {
          coreFiles.add(resolved)
        }
      }
    }
    coreTypes = emitDeclarations(root, [...coreFiles].sort(), o.alias)
    // stage 5 (foreign apps): the app's ambient declarations apply to every file without an import, e.g.
    // shadcn-admin's `declare module '@tanstack/react-table' { interface ColumnMeta … }` or TailAdmin's
    // `declare module '*.svg?react'`; without them the agent's type check sees the panels' own code as wrong
    coreTypes = [...coreTypes, ...ambientDeclarations(root, coreTypes)]
  }

  return {
    version: 1,
    dynamicRoots: [...new Set(o.dynamic.map(globRoot))],
    dynamic,
    readonly,
    coreTypes,
    externals: expandExternals(root, o.externals, o.alias),
    externalPatterns: o.externals,
    alias: o.alias,
    css: cssInfo(root, o.css, o.tailwindEntry),
    ...(o.protected.length ? { protected: o.protected } : {}),
    ...digests(root, o, readonly, coreTypes),
  }
}

/** `.d.ts` files of the app (outside node_modules and dist) that augment modules or the global scope. */
export function ambientDeclarations(root: string, already: ManifestFile[] = []): ManifestFile[] {
  const have = new Set(already.map((f) => f.path))
  return globSync(['src/**/*.d.ts'], { cwd: root, ignore: ['**/node_modules/**', '**/dist/**'], onlyFiles: true })
    .map(toPosix)
    .sort()
    .filter((p) => !have.has(p))
    .map((p) => ({ path: p, source: fs.readFileSync(path.join(root, p), 'utf8') }))
    .filter((f) => /^\s*declare\s+(module|global)\b/m.test(f.source) && f.source.length < 20_000)
}

/** Digests for the agent's cached prompt prefix (brainstorm 04 §1): design system and data contracts. */
function digests(root: string, o: ReturnType<typeof resolveOptions>, readonly: ManifestFile[], coreTypes: ManifestFile[]): Pick<PleatkitManifest, 'designSystem' | 'dataContracts'> {
  const out: Pick<PleatkitManifest, 'designSystem' | 'dataContracts'> = {}
  const patterns = o.designSystem?.components ?? []
  if (patterns.length) {
    const prefixes = patterns.map((p) => (aliasToPath(p.replace(/\*$/, ''), o.alias) ?? p.replace(/\*$/, '')).replace(/\/$/, ''))
    const files = [...readonly, ...coreTypes].filter((f) => prefixes.some((p) => f.path.startsWith(p)))
    const digest = designSystemDigest(files)
    let docs: string | undefined
    if (o.designSystem?.docs) {
      const file = path.join(root, o.designSystem.docs)
      if (fs.existsSync(file)) docs = fs.readFileSync(file, 'utf8').slice(0, 8_000)
    }
    if (digest || docs) out.designSystem = { digest, ...(docs ? { docs } : {}) }
  }
  // the data contract: readonly files named for data (api, types, models, client) and every file of a `readonly/`
  // folder (install.md step 5 puts what the panels read there), minus the design system's components
  const uiPrefixes = patterns.map((p) => (aliasToPath(p.replace(/\*$/, ''), o.alias) ?? p.replace(/\*$/, '')).replace(/\/$/, ''))
  const dataFiles = readonly.filter((f) => /\.(ts|tsx|mts)$/.test(f.path) && !uiPrefixes.some((p) => f.path.startsWith(p)) && (/\b(api|types?|models?|client)\b/i.test(f.path) || /(^|\/)readonly\//.test(f.path)))
  const contracts = dataContractsDigest(dataFiles, coreTypes, o.alias)
  if (contracts) out.dataContracts = { digest: contracts }
  return out
}

function cssInfo(root: string, mode: 'tailwind' | 'palette', entry: string): PleatkitManifest['css'] {
  if (mode !== 'tailwind') return { mode: 'palette', hash: 'palette' }
  const input = tailwindInput(root, entry)
  return { mode: 'tailwind', input, hash: createHash('sha256').update(input).digest('hex').slice(0, 32) }
}

// --- digests from declarations (brainstorm 04 §1, 05 #10) ---

const oneLine = (s: string): string => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim()

/** What one design-system file declares that a props type can refer to: local types and `cva()` variant tables. */
interface DigestScope {
  sf: ts.SourceFile
  types: Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>
  /** `const buttonVariants = cva(base, { variants: { variant: { default, … }, size: { … } } })` → variant → values. */
  variants: Map<string, [string, string[]][]>
  values: Map<string, ts.Node>
}

function scopeOf(sf: ts.SourceFile): DigestScope {
  const scope: DigestScope = { sf, types: new Map(), variants: new Map(), values: new Map() }
  sf.forEachChild((n) => {
    if ((ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) && n.name) scope.types.set(n.name.text, n)
    if (ts.isFunctionDeclaration(n) && n.name) scope.values.set(n.name.text, n)
    if (!ts.isVariableStatement(n)) return
    for (const d of n.declarationList.declarations) {
      if (!ts.isIdentifier(d.name)) continue
      scope.values.set(d.name.text, d)
      const init = d.initializer
      if (!init || !ts.isCallExpression(init) || init.expression.getText(sf) !== 'cva') continue
      const config = init.arguments[1]
      if (!config || !ts.isObjectLiteralExpression(config)) continue
      const table = config.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'variants')
      if (!table || !ts.isObjectLiteralExpression(table.initializer)) continue
      const rows: [string, string[]][] = []
      for (const v of table.initializer.properties) {
        if (!ts.isPropertyAssignment(v) || !ts.isObjectLiteralExpression(v.initializer)) continue
        rows.push([v.name.getText(sf).replace(/^['"]|['"]$/g, ''), v.initializer.properties.map((o) => (o.name ? o.name.getText(sf).replace(/^['"]|['"]$/g, '') : '')).filter(Boolean)])
      }
      scope.variants.set(d.name.text, rows)
    }
  })
  return scope
}

/** A member's type with local literal unions inlined: `color?: BadgeColor` → `color?: "primary" | "success"`. */
function memberText(m: ts.TypeElement, s: DigestScope): string {
  if (ts.isPropertySignature(m) && m.type && ts.isTypeReferenceNode(m.type)) {
    const decl = s.types.get(m.type.typeName.getText(s.sf))
    if (decl && ts.isTypeAliasDeclaration(decl) && ts.isUnionTypeNode(decl.type)) return `${m.name.getText(s.sf)}${m.questionToken ? '?' : ''}: ${oneLine(decl.type.getText(s.sf))}`
  }
  return oneLine(m.getText(s.sf)).replace(/;$/, '')
}

const variantEntries = (rows: [string, string[]][]): string[] => rows.map(([k, vs]) => k + '?: ' + vs.map((v) => JSON.stringify(v)).join(' | '))

/** Props of a local interface (its members, then what it extends) or type alias. */
function declProps(decl: ts.InterfaceDeclaration | ts.TypeAliasDeclaration, s: DigestScope, depth: number): string[] {
  if (depth > 4) return []
  if (ts.isTypeAliasDeclaration(decl)) return propsOfType(decl.type, s, depth)
  const inherited = (decl.heritageClauses ?? []).flatMap((h) => h.types.flatMap((t) => heritageProps(t, s, depth + 1)))
  return [...decl.members.map((m) => memberText(m, s)), ...inherited]
}

/** `extends VariantProps<typeof badgeVariants>`, `extends LocalProps`, or a DOM attribute type kept as `…X`. */
function heritageProps(t: ts.ExpressionWithTypeArguments, s: DigestScope, depth: number): string[] {
  const n = t.expression.getText(s.sf)
  const arg = t.typeArguments?.[0]
  if (/(^|\.)VariantProps$/.test(n) && arg && ts.isTypeQueryNode(arg)) {
    const rows = s.variants.get(arg.exprName.getText(s.sf))
    if (rows) return variantEntries(rows)
  }
  const decl = s.types.get(n)
  if (decl) return declProps(decl, s, depth)
  return ['…' + oneLine(t.getText(s.sf))]
}

/** The props a type says a component takes, one entry each; `…X` for a type it spreads in (DOM attributes). */
function propsOfType(type: ts.TypeNode | undefined, s: DigestScope, depth = 0): string[] {
  if (!type || depth > 4) return []
  if (ts.isParenthesizedTypeNode(type)) return propsOfType(type.type, s, depth)
  if (ts.isIntersectionTypeNode(type)) return type.types.flatMap((t) => propsOfType(t, s, depth + 1))
  if (ts.isTypeLiteralNode(type)) return type.members.map((m) => memberText(m, s))
  if (ts.isTypeReferenceNode(type)) {
    const name = type.typeName.getText(s.sf)
    // VariantProps<typeof buttonVariants>: the variant names and their values, from the cva() call
    if (/(^|\.)VariantProps$/.test(name) && type.typeArguments?.[0] && ts.isTypeQueryNode(type.typeArguments[0])) {
      const rows = s.variants.get(type.typeArguments[0].exprName.getText(s.sf))
      if (rows) return variantEntries(rows)
    }
    // React.FC<Props>, FC<Props>, forwardRef generics are handled by the caller
    if (/(^|\.)(FC|FunctionComponent)$/.test(name) && type.typeArguments?.[0]) return propsOfType(type.typeArguments[0], s, depth + 1)
    const decl = s.types.get(name)
    if (decl) return declProps(decl, s, depth + 1)
    return [`…${oneLine(type.getText(s.sf))}`]
  }
  return [oneLine(type.getText(s.sf)).slice(0, 200)]
}

/** The props type of a component declaration: a function's first parameter, a typed const, an arrow, forwardRef. */
function componentProps(node: ts.Node, s: DigestScope): string[] | null {
  if (ts.isFunctionDeclaration(node)) return propsOfType(node.parameters[0]?.type, s)
  if (!ts.isVariableDeclaration(node)) return null
  if (node.type) return propsOfType(node.type, s)
  const init = node.initializer
  if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return propsOfType(init.parameters[0]?.type, s)
  // React.forwardRef<HTMLButtonElement, ButtonProps>(…)
  if (init && ts.isCallExpression(init) && /forwardRef$/.test(init.expression.getText(s.sf))) {
    if (init.typeArguments?.[1]) return propsOfType(init.typeArguments[1], s)
    const fn = init.arguments[0]
    if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return propsOfType(fn.parameters[0]?.type, s)
  }
  return null
}

const MAX_COMPONENT_CHARS = 400

/**
 * One line per file of the design system, one entry per exported component with its props and their values:
 * `Badge(variant?: "default" | "secondary" | "outline", asChild?: boolean, …React.ComponentProps<'span'>)`.
 * Variants come from local `cva()` tables (`VariantProps<typeof badgeVariants>`), local literal unions are inlined
 * (`color?: BadgeColor` → the colours), DOM attribute types stay one `…` entry. Components exported with
 * `export function`, `export const`, `export { A, B }` or `export default A`. Unknown shapes keep their name.
 */
export function designSystemDigest(files: ManifestFile[]): string {
  const lines: string[] = []
  for (const f of files) {
    const sf = ts.createSourceFile(f.path, f.source, ts.ScriptTarget.Latest, true, f.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const s = scopeOf(sf)
    const exported = new Map<string, string>()
    const add = (name: string, node: ts.Node | undefined) => {
      if (!/^[A-Z]/.test(name) || exported.has(name)) return
      const props = node ? componentProps(node, s) : null
      // the component's own props first, the DOM attributes it passes through last
      const ordered = props && [...props.filter((p) => !p.startsWith('…')), ...props.filter((p) => p.startsWith('…'))]
      let entry = ordered === null ? name : `${name}(${ordered.join(', ')})`
      if (entry.length > MAX_COMPONENT_CHARS) entry = entry.slice(0, MAX_COMPONENT_CHARS - 1) + '…)'
      exported.set(name, entry)
    }
    sf.forEachChild((n) => {
      const isExported = (ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Export) !== 0
      if (ts.isFunctionDeclaration(n) && n.name && isExported) add(n.name.text, n)
      else if (ts.isVariableStatement(n) && isExported) {
        for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name)) add(d.name.text, d)
      } else if (ts.isExportDeclaration(n) && n.exportClause && ts.isNamedExports(n.exportClause) && !n.moduleSpecifier) {
        for (const e of n.exportClause.elements) add(e.name.text, s.values.get((e.propertyName ?? e.name).text))
      } else if (ts.isExportDeclaration(n) && n.exportClause && ts.isNamedExports(n.exportClause)) {
        for (const e of n.exportClause.elements) add(e.name.text, undefined)
      } else if (ts.isExportAssignment(n) && ts.isIdentifier(n.expression)) {
        add(n.expression.text, s.values.get(n.expression.text))
      }
    })
    if (exported.size) lines.push(`${f.path.replace(/\.(d\.ts|tsx?|jsx?)$/, '')}: ${[...exported.values()].join('; ')}`)
  }
  return lines.join('\n')
}

/** Entities and client methods of the readonly zone, signatures only (no bodies): the agent's data contract. */
export function dataContractsDigest(files: ManifestFile[], coreTypes: ManifestFile[] = [], alias: Record<string, string> = { '@': 'src' }): string {
  const lines: string[] = []
  const types = new Map(coreTypes.map((f) => [f.path, f]))
  const shown = new Set<string>()
  for (const f of files) {
    const sf = ts.createSourceFile(f.path, f.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const parts: string[] = []
    // stage 5 (foreign apps): a readonly module that re-exports the app's own data (`export { roles, type User } from
    // '@/features/users/data'`) declares nothing itself; the declarations of what it imports or re-exports from core
    // files come along, from their `.d.ts` (the agent sees those files only as types anyway)
    const from: string[] = []
    sf.forEachChild((n) => {
      const spec = (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : null
      if (ts.isImportDeclaration(n) && n.importClause?.isTypeOnly === false && !n.importClause.name && !n.importClause.namedBindings) return
      if (!spec) return
      const base = spec.startsWith('.') ? path.posix.join(path.posix.dirname(f.path), spec) : aliasToPath(spec, alias)
      if (!base) return
      const hit = [`${base}.d.ts`, `${base}/index.d.ts`].find((p) => types.has(p))
      if (hit && !shown.has(hit) && !/\/components\//.test(hit)) from.push(hit)
    })
    for (const hit of from) {
      shown.add(hit)
      const decl = types
        .get(hit)!
        .source.replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/import\("[^"]*"\)\./g, '')
        .replace(/^\s*(import .*|export \{\};?)$/gm, '')
        .replace(/\s+/g, ' ')
        // the emitted types of zod schemas and icon components, shortened to what they mean
        .replace(/z\.ZodLiteral<("[^"]*")>/g, '$1')
        .replace(/z\.ZodUnion<readonly \[([^\]]*)\]>/g, (_m, xs: string) => xs.split(', ').join(' | '))
        .replace(/z\.ZodString/g, 'string')
        .replace(/z\.ZodNumber/g, 'number')
        .replace(/z\.ZodBoolean/g, 'boolean')
        .replace(/z\.Zod(Coerced)?Date<unknown>/g, 'Date')
        .replace(/ForwardRefExoticComponent<Omit<\w+Props, "ref"> & RefAttributes<\w+>>/g, 'IconComponent')
        .trim()
      if (decl) parts.push(`// from ${hit}: ${decl.length > 1500 ? decl.slice(0, 1500) + ' …' : decl}`)
    }
    sf.forEachChild((n) => {
      const isExported = (ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Export) !== 0
      if (!isExported) return
      if (ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) parts.push(n.getText(sf).replace(/\s+/g, ' ').replace(/^export /, ''))
      else if (ts.isFunctionDeclaration(n) && n.name) parts.push(`function ${n.name.text}(${n.parameters.map((p) => p.getText(sf)).join(', ')})${n.type ? ': ' + n.type.getText(sf) : ''}`)
      else if (ts.isVariableStatement(n)) {
        for (const d of n.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue
          if (d.initializer && ts.isObjectLiteralExpression(d.initializer)) {
            const methods = d.initializer.properties.map((p) => {
              if (ts.isMethodDeclaration(p) || ts.isPropertyAssignment(p)) {
                const fn = ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer)) ? p.initializer : ts.isMethodDeclaration(p) ? p : null
                const name = p.name.getText(sf)
                return fn ? `${name}(${fn.parameters.map((x) => x.getText(sf)).join(', ')})${fn.type ? ': ' + fn.type.getText(sf) : ''}` : name
              }
              return p.getText(sf).slice(0, 80)
            })
            parts.push(`${d.name.text}: { ${methods.join('; ')} }`)
          } else parts.push(`const ${d.name.text}${d.type ? ': ' + d.type.getText(sf) : ''}`)
        }
      }
    })
    if (parts.length) lines.push(`// ${f.path}\n${parts.map((p) => p.slice(0, 600)).join('\n')}`)
  }
  return lines.join('\n')
}
