import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import type { CompileError, FileMap } from '@pleatkit/runtime/compiler'
import type { TypecheckFn, WorkspaceInput } from './workspace.js'

/**
 * Type check of the dynamic zone against the app's types (brainstorm 05 #4): esbuild strips types, so an edit
 * that calls `api.listDeals(1)` where the client takes a string compiles and fails at run time (or reads a variable
 * before its declaration, stage 5: Haiku's ta-09). With a typechecker (by default when the app's packages are found,
 * `typecheckFromEnv`) the agent's `check` also runs TypeScript over the dynamic files with
 * the readonly sources and the core `.d.ts` from the manifest. Only errors in dynamic files are reported, and with
 * the release's files (`input.base`) only those the release does not already have (stage 5: a foreign app's own
 * panels may not pass this checker's settings). The app's ambient declarations among the core types are roots.
 *
 * Packages (react, a UI kit) resolve from `root` (the app's folder, PLEATKIT_TYPECHECK_ROOT) when it has them
 * installed; otherwise they are `any` and only the app's own contracts are checked.
 */
export interface TypecheckOptions {
  /** Folder whose node_modules provide the types of packages (the app). Default: none (packages are `any`). */
  root?: string | null
  /**
   * Stage 5 block 5: keep the resolutions on disk and reuse the previous program (default true). False is the cold
   * checker of blocks 3 and 4, for measurements (`PLEATKIT_TYPECHECK_WARM=0`).
   */
  warm?: boolean
}

/** Codes that only say "a package's types are not available here": not the edit's fault. */
const IGNORED = new Set([
  2307, // Cannot find module 'react'
  7016, // Could not find a declaration file for module
  2875, // This JSX tag requires the module path 'react/jsx-runtime'
  2792, // Cannot find module ... moduleResolution
  7026, // JSX element implicitly has type 'any'
])

const libCache = new Map<string, ts.SourceFile>()

/** An error without its position: the same problem on another line is the same problem. */
const errorKey = (e: CompileError): string => `${e.file}|${e.text}`

export function createTypechecker(options: TypecheckOptions = {}): TypecheckFn {
  const root = options.root ? path.resolve(options.root) : null
  const libDir = path.dirname(ts.getDefaultLibFilePath({}))
  // stage 5 (foreign apps): the release's own panels can carry type errors under this checker's settings (a
  // stricter app tsconfig, an app's own lib choices); an edit is refused only for errors it introduced
  const baseErrors = new Map<string, Set<string>>()
  // stage 5 block 5 (brainstorm 17 §4): the warm checker. Resolving a package's .d.ts graph on disk (react, TanStack
  // Table, recharts: thousands of lookups) took 1 to 2 s of every check on shadcn-admin, although the answer never
  // changes while the agent runs. Resolutions on disk are kept for the checker's life (one per app), and each program
  // is built from the previous one (TypeScript reuses its unchanged structure).
  const warm = options.warm !== false
  const diskResolutions = new Map<string, ts.ResolvedModuleWithFailedLookupLocations>()
  let previous: ts.Program | undefined
  const diagnose = async (files: FileMap, input: WorkspaceInput, limit: number, only?: string[]): Promise<CompileError[]> => {
    const virtual = new Map<string, string>()
    const add = (map: FileMap) => {
      for (const [p, s] of Object.entries(map)) virtual.set('/' + p, s)
    }
    add(input.coreTypes)
    add(input.readonly)
    add(files)
    const paths: Record<string, string[]> = {}
    for (const [key, dir] of Object.entries(input.context.alias)) paths[`${key}/*`] = [`/${dir.replace(/\/$/, '')}/*`]
    const compilerOptions: ts.CompilerOptions = {
      noEmit: true,
      strict: false,
      noImplicitAny: false,
      skipLibCheck: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
      types: [],
      esModuleInterop: true,
      allowJs: true,
      resolveJsonModule: true,
      baseUrl: '/',
      paths,
    }
    const exists = (f: string) => virtual.has(f) || virtual.has(f.replace(/\.d\.ts$/, '.ts'))
    const host: ts.CompilerHost = {
      getSourceFile: (fileName, languageVersion) => {
        const v = virtual.get(fileName)
        if (v !== undefined) return ts.createSourceFile(fileName, v, languageVersion, true)
        const hit = libCache.get(fileName)
        if (hit) return hit
        const text = ts.sys.readFile(fileName)
        if (text === undefined) return undefined
        const sf = ts.createSourceFile(fileName, text, languageVersion, true)
        if (fileName.startsWith(libDir) || fileName.includes('node_modules')) libCache.set(fileName, sf)
        return sf
      },
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      writeFile: () => undefined,
      getCurrentDirectory: () => '/',
      getDirectories: () => [],
      fileExists: (f) => exists(f) || ts.sys.fileExists(f),
      readFile: (f) => virtual.get(f) ?? ts.sys.readFile(f),
      getCanonicalFileName: (f) => f,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
      resolveModuleNameLiterals: (literals, containingFile) =>
        literals.map((lit) => {
          const spec = lit.text
          // inside a package's own .d.ts (react/jsx-runtime.d.ts imports "./"), resolve on disk: resolving it
          // against the virtual files lost the JSX namespace, so every JSX element became `any` and `key` an error
          if (root && !virtual.has(containingFile)) {
            if (!warm) return ts.resolveModuleName(spec, containingFile, { ...compilerOptions, paths: {}, baseUrl: undefined }, ts.sys)
            const key = `${containingFile}\0${spec}`
            let hit = diskResolutions.get(key)
            if (!hit) diskResolutions.set(key, (hit = ts.resolveModuleName(spec, containingFile, { ...compilerOptions, paths: {}, baseUrl: undefined }, ts.sys)))
            return hit
          }
          const virtualHost: ts.ModuleResolutionHost = { fileExists: (f) => exists(f), readFile: (f) => virtual.get(f) }
          const local = ts.resolveModuleName(spec, containingFile, compilerOptions, virtualHost)
          if (local.resolvedModule) return local
          if (root && !spec.startsWith('.') && !spec.startsWith('/')) {
            // a package from a virtual file: the same answer from any of them
            if (!warm) return ts.resolveModuleName(spec, path.join(root, '__pleatkit_typecheck__.ts'), { ...compilerOptions, paths: {}, baseUrl: undefined }, ts.sys)
            const key = `\0pkg\0${spec}`
            let hit = diskResolutions.get(key)
            if (!hit) diskResolutions.set(key, (hit = ts.resolveModuleName(spec, path.join(root, '__pleatkit_typecheck__.ts'), { ...compilerOptions, paths: {}, baseUrl: undefined }, ts.sys)))
            return hit
          }
          return local
        }),
    }
    const dynamic = only ?? dynamicScripts(files, input)
    // the app's ambient declarations (`declare module '@tanstack/react-table' { … }`, `*.svg?react`) are not
    // imported by anything: they apply only as roots of the program
    const ambient = Object.keys(input.coreTypes).filter((p) => p.endsWith('.d.ts') && /^\s*declare\s+(module|global)\b/m.test(input.coreTypes[p]!))
    const program = ts.createProgram({ rootNames: [...dynamic, ...ambient].map((p) => '/' + p), options: compilerOptions, host, ...(previous ? { oldProgram: previous } : {}) })
    if (warm) previous = program
    const out: CompileError[] = []
    for (const p of dynamic) {
      const sf = program.getSourceFile('/' + p)
      if (!sf) continue
      for (const d of [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]) {
        if (IGNORED.has(d.code)) continue
        const { line, character } = d.start !== undefined ? sf.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 }
        out.push({ file: p, line: line + 1, column: character + 1, text: `${ts.flattenDiagnosticMessageText(d.messageText, ' ')} (TS${d.code}) [typecheck]`, rule: 'typecheck' })
        if (out.length >= limit) return out
      }
    }
    return out
  }
  const check = async (files: FileMap, input: WorkspaceInput): Promise<CompileError[]> => {
    const base = input.base
    const hasBase = Boolean(base && Object.keys(base).length)
    // 74.2: with the release known, only the files the edit changed and the dynamic files importing them are checked
    // (a full check of shadcn-admin's seven panels took 2.5 s per check; the changed ones are what can break)
    const only = hasBase ? affectedFiles(files, base!, input) : undefined
    if (only && only.length === 0) return []
    const errors = await diagnose(files, input, 200, only)
    if (!errors.length || !base || !hasBase) return errors.slice(0, 20)
    const key = JSON.stringify(Object.keys(base).sort().map((p) => [p, base[p]!.length, hashText(base[p]!)]))
    let known = baseErrors.get(key)
    if (!known) {
      known = new Set((await diagnose(base, input, 1000)).map(errorKey))
      if (baseErrors.size > 50) baseErrors.clear()
      baseErrors.set(key, known)
    }
    return errors.filter((e) => !known.has(errorKey(e))).slice(0, 20)
  }
  return check
}

/**
 * Warm the checker before the first edit (brainstorm 17 §4): check the release's own panels once, so the packages'
 * declarations are parsed and resolved when the first user asks. Errors are ignored (the release's own errors are
 * the baseline anyway); the returned promise never rejects.
 */
export async function warmTypecheck(typecheck: TypecheckFn, input: WorkspaceInput): Promise<number> {
  const started = performance.now()
  try {
    await typecheck(input.files, { ...input, base: {} })
  } catch {
    // warming is best effort
  }
  return performance.now() - started
}

const dynamicScripts = (files: FileMap, input: WorkspaceInput): string[] =>
  Object.keys(files).filter((p) => /\.(tsx|ts|jsx|js)$/.test(p) && input.context.dynamicRoots.some((r) => p.startsWith(r)))

/** Dynamic scripts that differ from the release, and the dynamic scripts that import one of them (relative imports). */
export function affectedFiles(files: FileMap, base: FileMap, input: WorkspaceInput): string[] {
  const scripts = dynamicScripts(files, input)
  const changed = new Set(scripts.filter((p) => files[p] !== base[p]))
  if (changed.size === 0) return []
  const resolves = (from: string, spec: string): string | null => {
    const target = path.posix.join(path.posix.dirname(from), spec)
    return ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts'].map((e) => target + e).find((c) => c in files) ?? null
  }
  const out = new Set(changed)
  for (const p of scripts) {
    if (out.has(p)) continue
    for (const m of files[p]!.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const hit = resolves(p, m[1]!)
      if (hit && changed.has(hit)) {
        out.add(p)
        break
      }
    }
  }
  return [...out].sort()
}

/** A cheap 32-bit hash for the cache key of a release's files (not security relevant). */
function hashText(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return h
}

/**
 * The app folder of a manifest file (`<app>/dist/pleatkit.manifest.json` → `<app>`): the nearest folder at most two
 * levels up that has `package.json` and `node_modules`. Null for a URL or when none is found (the cloud has the
 * manifest but not the app's packages).
 */
export function appRootOf(manifestLocation: string | undefined): string | null {
  if (!manifestLocation || /^https?:\/\//.test(manifestLocation)) return null
  let dir = path.dirname(path.resolve(manifestLocation))
  for (let i = 0; i < 3; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'node_modules'))) return dir
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

/**
 * DECISIONS 63.4 and 74.2: the agent loop type-checks edits by default when the app's types are available.
 *
 * - `PLEATKIT_TYPECHECK=0` (or `off`, `false`): off.
 * - `PLEATKIT_TYPECHECK=1` (or `true`): on; packages resolve from `PLEATKIT_TYPECHECK_ROOT` or the app folder next
 *   to the manifest, else they are `any` (only the app's own contracts are checked).
 * - unset (`auto`): on when an app folder with `node_modules` is found (`PLEATKIT_TYPECHECK_ROOT`, or next to
 *   `PLEATKIT_MANIFEST` / each manifest of `PLEATKIT_MANIFESTS`), else off. The cloud has no app packages: off there.
 *
 * With several manifests each app is checked against its own folder (by the compile context's namespace, the app id).
 */
export function typecheckFromEnv(env: Record<string, string | undefined>): TypecheckFn | null {
  const mode = (env.PLEATKIT_TYPECHECK ?? 'auto').trim().toLowerCase()
  if (mode === '0' || mode === 'off' || mode === 'false') return null
  const forced = mode === '1' || mode === 'true' || mode === 'on'
  const warm = !['0', 'off', 'false'].includes((env.PLEATKIT_TYPECHECK_WARM ?? '').trim().toLowerCase())
  const explicit = env.PLEATKIT_TYPECHECK_ROOT
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`PLEATKIT_TYPECHECK_ROOT ${explicit} does not exist`)
    return createTypechecker({ root: explicit, warm })
  }
  const defaultRoot = appRootOf(env.PLEATKIT_MANIFEST)
  const roots = new Map<string, string>()
  if (env.PLEATKIT_MANIFESTS) {
    try {
      for (const [appId, where] of Object.entries(JSON.parse(env.PLEATKIT_MANIFESTS) as Record<string, string>)) {
        const root = appRootOf(where)
        if (root) roots.set(appId, root)
      }
    } catch {
      // manifestSourceFromEnv reports the bad JSON
    }
  }
  if (!forced && !defaultRoot && roots.size === 0) return null
  const fallback = defaultRoot || forced ? createTypechecker({ root: defaultRoot, warm }) : null
  if (roots.size === 0) return fallback
  const perApp = new Map([...roots].map(([appId, root]) => [appId, createTypechecker({ root, warm })]))
  return async (files, input) => {
    const fn = perApp.get(input.context.namespace ?? '') ?? fallback
    return fn ? fn(files, input) : []
  }
}
