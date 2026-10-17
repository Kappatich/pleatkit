import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import picomatch from 'picomatch'
import ts from 'typescript'
import { globSync } from 'tinyglobby'
import { validateZoneGlob } from '@morphkit/runtime/compiler'
import { emitDeclarations } from './declarations.js'
import { tailwindInput } from './tailwind.js'

export interface ZonesOptions {
  /** Globs (relative to project root) the agent may edit; compiled at runtime. */
  dynamic: string[]
  /** Globs the agent may read but not edit. Everything else is core. */
  readonly?: string[]
}

export interface MorphkitOptions {
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
   * `/morphkit/b/…` with `import()`; the page needs neither WebAssembly nor `blob:`. `browser`: esbuild-wasm in
   * the page (falls back to the server by itself when WebAssembly cannot load).
   */
  compile?: 'server' | 'browser'
  /**
   * Public key of the app key (V1 A3, `npx morphkit keys public`): when set, the runtime runs only bundles
   * signed with it. Default: the MORPHKIT_PUBLIC_KEY environment variable at build time.
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

export interface MorphkitManifest {
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
    if (fatal.length) throw new Error(`[morphkit] zones.${kind}: ${fatal.join('; ')}`)
    return glob
  })
}

export function resolveOptions(options: MorphkitOptions) {
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
    publicKey: options.publicKey ?? process.env.MORPHKIT_PUBLIC_KEY ?? null,
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

export function buildManifest(root: string, options: MorphkitOptions): MorphkitManifest {
  const o = resolveOptions(options)
  const dynamic = readFiles(root, o.dynamic)
  const readonly = readFiles(root, o.readonly, o.dynamic)
  if (dynamic.length === 0 && o.dynamic.length > 0) {
    console.warn(`[morphkit] zones.dynamic (${o.dynamic.join(', ')}) matches no files under ${root}: nothing will be editable`)
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

/** Digests for the agent's cached prompt prefix (brainstorm 04 §1): design system and data contracts. */
function digests(root: string, o: ReturnType<typeof resolveOptions>, readonly: ManifestFile[], coreTypes: ManifestFile[]): Pick<MorphkitManifest, 'designSystem' | 'dataContracts'> {
  const out: Pick<MorphkitManifest, 'designSystem' | 'dataContracts'> = {}
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
  const contracts = dataContractsDigest(readonly.filter((f) => /\b(api|types?|models?|client)\b/i.test(f.path)))
  if (contracts) out.dataContracts = { digest: contracts }
  return out
}

function cssInfo(root: string, mode: 'tailwind' | 'palette', entry: string): MorphkitManifest['css'] {
  if (mode !== 'tailwind') return { mode: 'palette', hash: 'palette' }
  const input = tailwindInput(root, entry)
  return { mode: 'tailwind', input, hash: createHash('sha256').update(input).digest('hex').slice(0, 32) }
}

// --- digests from declarations (brainstorm 04 §1, 05 #10) ---

function propsOf(type: ts.TypeNode | undefined, sf: ts.SourceFile, locals: Map<string, ts.Node>): string {
  if (!type) return ''
  if (ts.isTypeReferenceNode(type)) {
    const decl = locals.get(type.typeName.getText(sf))
    if (decl && (ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl))) {
      const members = ts.isInterfaceDeclaration(decl) ? decl.members : ts.isTypeLiteralNode(decl.type) ? decl.type.members : undefined
      if (members) return members.map((mm) => mm.getText(sf).replace(/\s+/g, ' ').replace(/;$/, '')).join(', ')
      return decl.getText(sf).replace(/\s+/g, ' ').slice(0, 200)
    }
  }
  if (ts.isTypeLiteralNode(type)) return type.members.map((mm) => mm.getText(sf).replace(/\s+/g, ' ').replace(/;$/, '')).join(', ')
  return type.getText(sf).replace(/\s+/g, ' ').slice(0, 200)
}

/**
 * One line per exported component: `Button({ variant?: 'default' | 'destructive', size?: ... })`, from the
 * component files of the design system (sources or `.d.ts`). Unknown shapes keep their name.
 */
export function designSystemDigest(files: ManifestFile[]): string {
  const lines: string[] = []
  for (const f of files) {
    const sf = ts.createSourceFile(f.path, f.source, ts.ScriptTarget.Latest, true, f.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const locals = new Map<string, ts.Node>()
    sf.forEachChild((n) => {
      if ((ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) && n.name) locals.set(n.name.text, n)
    })
    const exported: string[] = []
    sf.forEachChild((n) => {
      const isExported = (ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Export) !== 0
      if (ts.isFunctionDeclaration(n) && n.name && isExported && /^[A-Z]/.test(n.name.text)) {
        exported.push(`${n.name.text}(${propsOf(n.parameters[0]?.type, sf, locals)})`)
      } else if (ts.isVariableStatement(n) && isExported) {
        for (const d of n.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !/^[A-Z]/.test(d.name.text)) continue
          const t = d.type?.getText(sf).replace(/\s+/g, ' ').slice(0, 160)
          exported.push(t ? `${d.name.text}: ${t}` : d.name.text)
        }
      } else if (ts.isExportDeclaration(n) && n.exportClause && ts.isNamedExports(n.exportClause)) {
        for (const e of n.exportClause.elements) if (/^[A-Z]/.test(e.name.text)) exported.push(e.name.text)
      }
    })
    if (exported.length) lines.push(`${f.path.replace(/\.(d\.ts|tsx?|jsx?)$/, '')}: ${exported.join('; ')}`)
  }
  return lines.join('\n')
}

/** Entities and client methods of the readonly zone, signatures only (no bodies): the agent's data contract. */
export function dataContractsDigest(files: ManifestFile[]): string {
  const lines: string[] = []
  for (const f of files) {
    const sf = ts.createSourceFile(f.path, f.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const parts: string[] = []
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
