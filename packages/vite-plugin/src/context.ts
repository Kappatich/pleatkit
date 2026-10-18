import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { emitDeclarations } from './declarations.js'
import type { ManifestFile } from './manifest.js'

/**
 * DECISIONS 74.6 (brainstorm 04 §1, I8): the readonly context of the agent's cached prompt holds only what the editable
 * panels can reach. Starting from the imports of the release's dynamic files, it follows the imported names through
 * barrels (`export { X } from './x'` is followed only for the X a panel uses) and the declarations of every module it
 * reaches (the types they refer to), and shows each module as its `.d.ts`, not its source. Everything else stays
 * readable with read_file and still feeds the type check; only the prompt is smaller.
 */
export interface AgentContext {
  /** `.d.ts` of the reachable readonly modules and core types, in a stable order. */
  files: ManifestFile[]
  /** Reachable modules left out because the context went over its cap (the farthest from the panels first). */
  omitted: string[]
  /** Size of the context and the cap, in estimated tokens (2.2 characters per token of code). */
  estimatedTokens: number
  capTokens: number
  /** What the prompt held before the trimming: all readonly sources and core types, estimated tokens. */
  untrimmedTokens: number
}

export const DEFAULT_CONTEXT_CAP_TOKENS = 12_000
const CHARS_PER_TOKEN = 2.2

type Wanted = Set<string> | '*'

interface ModuleRefs {
  /** Imported or re-exported names per specifier; `*` for a namespace import or `export *`. */
  imports: { spec: string; names: Wanted; reexport: boolean; as: Map<string, string> }[]
  /** Names this module declares and exports itself. */
  own: Set<string>
}

/** The import and export statements of a module (source or `.d.ts`). */
export function moduleRefs(file: string, source: string): ModuleRefs {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const refs: ModuleRefs = { imports: [], own: new Set() }
  for (const n of sf.statements) {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const clause = n.importClause
      const names = new Set<string>()
      let all = false
      if (clause?.name) names.add('default')
      const b = clause?.namedBindings
      if (b && ts.isNamespaceImport(b)) all = true
      if (b && ts.isNamedImports(b)) for (const e of b.elements) names.add((e.propertyName ?? e.name).text)
      refs.imports.push({ spec: n.moduleSpecifier.text, names: all ? '*' : names, reexport: false, as: new Map() })
    } else if (ts.isExportDeclaration(n)) {
      if (n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        const as = new Map<string, string>()
        if (n.exportClause && ts.isNamedExports(n.exportClause)) for (const e of n.exportClause.elements) as.set(e.name.text, (e.propertyName ?? e.name).text)
        refs.imports.push({ spec: n.moduleSpecifier.text, names: n.exportClause ? new Set(as.values()) : '*', reexport: true, as })
      } else if (n.exportClause && ts.isNamedExports(n.exportClause)) for (const e of n.exportClause.elements) refs.own.add(e.name.text)
    } else if (ts.isExportAssignment(n)) refs.own.add('default')
    else if ((ts.getCombinedModifierFlags(n as unknown as ts.Declaration) & ts.ModifierFlags.Export) !== 0) {
      if (ts.isVariableStatement(n)) {
        for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name)) refs.own.add(d.name.text)
      }
      else if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n)) && n.name) refs.own.add(n.name.text)
    }
  }
  return refs
}

export interface ContextInput {
  root: string
  alias: Record<string, string>
  dynamic: ManifestFile[]
  readonly: ManifestFile[]
  coreTypes: ManifestFile[]
  /** `spec` imported by `importer` → the project file (relative to root), or null for a package. */
  resolve: (spec: string, importer: string) => string | null
  isDynamic: (file: string) => boolean
  capTokens?: number
  /** `.d.ts` of readonly files (default: TypeScript's declaration emit over the app, as for core types). */
  declarations?: (files: string[]) => ManifestFile[]
}

const merge = (a: Wanted | undefined, b: Wanted): Wanted => (a === '*' || b === '*' ? '*' : new Set([...(a ?? []), ...b]))
const covers = (a: Wanted | undefined, b: Wanted): boolean => a === '*' || (b !== '*' && a !== undefined && [...b].every((x) => a.has(x)))

export function buildAgentContext(input: ContextInput): AgentContext {
  const cap = input.capTokens ?? DEFAULT_CONTEXT_CAP_TOKENS
  const readonly = new Map(input.readonly.map((f) => [f.path, f.source]))
  const core = new Map(input.coreTypes.map((f) => [f.path, f.source]))
  // every readonly module as its declarations: reachability follows what the declarations import (a helper's
  // runtime imports, such as `cn`, do not make their modules part of its API)
  const emit = input.declarations ?? ((files: string[]) => emitDeclarations(input.root, files, input.alias))
  const scripts = input.readonly.filter((f) => /\.(tsx?|mts)$/.test(f.path) && !f.path.endsWith('.d.ts')).map((f) => f.path)
  const emitted = new Map(emit(scripts).map((f) => [f.path, f.source]))
  const dtsPath = (file: string) => file.replace(/\.(tsx?|mts|jsx?)$/, '.d.ts')
  // a core file is known by its `.d.ts`; a readonly one by its source
  const coreOf = (file: string): string | null => {
    const d = file.replace(/\.(tsx?|mts|jsx?)$/, '.d.ts')
    return core.has(d) ? d : core.has(file) ? file : null
  }
  const wanted = new Map<string, Wanted>()
  const depth = new Map<string, number>()
  const queue: string[] = []
  const want = (file: string, names: Wanted, d: number) => {
    const before = wanted.get(file)
    if (covers(before, names)) return
    wanted.set(file, merge(before, names))
    if (!depth.has(file) || depth.get(file)! > d) depth.set(file, d)
    queue.push(file)
  }
  const follow = (importer: string, refs: ModuleRefs, d: number, need: Wanted | null) => {
    for (const imp of refs.imports) {
      const target = input.resolve(imp.spec, importer)
      if (!target || input.isDynamic(target) || target.endsWith('.css')) continue
      if (!readonly.has(target) && !coreOf(target)) continue
      if (imp.reexport && need !== null) {
        // a barrel: only the names someone asked this module for
        if (need === '*') want(target, imp.names, d + 1)
        else if (imp.names === '*') {
          const rest = [...need].filter((x) => !refs.own.has(x))
          if (rest.length) want(target, new Set(rest), d + 1)
        } else {
          const asked = [...imp.as].filter(([exported]) => need.has(exported)).map(([, local]) => local)
          if (asked.length) want(target, new Set(asked), d + 1)
        }
      } else if (!imp.reexport) want(target, imp.names, d + 1)
    }
  }

  for (const f of input.dynamic) follow(f.path, moduleRefs(f.path, f.source), -1, null)

  // the modules the panels reach (a barrel is shown too: it maps the names the panels import)
  const done = new Map<string, Wanted>()
  while (queue.length) {
    const file = queue.shift()!
    const need = wanted.get(file)!
    if (covers(done.get(file), need)) continue
    done.set(file, need)
    const coreFile = coreOf(file)
    const source = readonly.has(file) ? (emitted.get(dtsPath(file)) ?? null) : coreFile ? core.get(coreFile)! : null
    if (source === null) continue
    const refs = moduleRefs(file, source)
    const ownUsed = need === '*' ? refs.own.size > 0 : [...need].some((x) => refs.own.has(x))
    // re-exports by the names asked; the module's own imports when it is shown (its declarations refer to them)
    follow(file, { imports: refs.imports.filter((i) => i.reexport), own: refs.own }, depth.get(file)!, need)
    if (ownUsed) follow(file, { imports: refs.imports.filter((i) => !i.reexport), own: refs.own }, depth.get(file)!, null)
  }

  const reached = [...done.keys()]
  const shown: (ManifestFile & { depth: number })[] = []
  for (const file of reached) {
    const coreFile = coreOf(file)
    const dts = readonly.has(file) ? emitted.get(dtsPath(file)) : coreFile ? core.get(coreFile) : undefined
    if (dts === undefined) continue
    const text = tidy(dts)
    if (!text) continue
    shown.push({ path: readonly.has(file) ? dtsPath(file) : (coreFile ?? file), source: text, depth: depth.get(file) ?? 0 })
  }
  // the cap: the farthest modules go first
  shown.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
  const omitted: string[] = []
  let chars = shown.reduce((s, f) => s + f.source.length, 0)
  while (shown.length && chars / CHARS_PER_TOKEN > cap) {
    const last = shown.pop()!
    chars -= last.source.length
    omitted.push(last.path)
  }
  const untrimmed = [...input.readonly, ...input.coreTypes].reduce((s, f) => s + f.source.length, 0)
  return {
    files: shown.map(({ path: p, source }) => ({ path: p, source })).sort((a, b) => a.path.localeCompare(b.path)),
    omitted: omitted.sort(),
    estimatedTokens: Math.round(chars / CHARS_PER_TOKEN),
    capTokens: cap,
    untrimmedTokens: Math.round(untrimmed / CHARS_PER_TOKEN),
  }
}

/** A `.d.ts` without the emitter's noise: `export {};`, imports of assets (an icon module's svg lines), blank runs. */
function tidy(dts: string): string {
  return dts
    .replace(/^export \{\};?\s*$/gm, '')
    .replace(/^import [^;\n]* from ["'][^"'\n]+\.(svg|png|jpe?g|gif|webp|avif|ico|css)(\?[^"'\n]*)?["'];?\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** For tests and `pleatkit doctor`: does this project file exist (relative to root)? */
export const exists = (root: string, file: string): boolean => fs.existsSync(path.join(root, file))
