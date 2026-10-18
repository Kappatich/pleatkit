import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import type { CompileError, FileMap } from '@pleatkit/runtime/compiler'
import type { TypecheckFn, WorkspaceInput } from './workspace.js'
import { pleatkitEnv } from '@pleatkit/runtime/env'

/**
 * Type check of the dynamic zone against the app's types (brainstorm 05 #4): esbuild strips types, so an edit
 * that calls `api.listDeals(1)` where the client takes a string compiles and fails at run time. With
 * `typecheck: true` (PLEATKIT_TYPECHECK=1) the agent's `check` also runs TypeScript over the dynamic files with
 * the readonly sources and the core `.d.ts` from the manifest. Only errors in dynamic files are reported.
 *
 * Packages (react, a UI kit) resolve from `root` (the app's folder, PLEATKIT_TYPECHECK_ROOT) when it has them
 * installed; otherwise they are `any` and only the app's own contracts are checked.
 */
export interface TypecheckOptions {
  /** Folder whose node_modules provide the types of packages (the app). Default: none (packages are `any`). */
  root?: string | null
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

export function createTypechecker(options: TypecheckOptions = {}): TypecheckFn {
  const root = options.root ? path.resolve(options.root) : null
  const libDir = path.dirname(ts.getDefaultLibFilePath({}))
  return async (files: FileMap, input: WorkspaceInput): Promise<CompileError[]> => {
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
          if (root && !virtual.has(containingFile)) return ts.resolveModuleName(spec, containingFile, { ...compilerOptions, paths: {}, baseUrl: undefined }, ts.sys)
          const virtualHost: ts.ModuleResolutionHost = { fileExists: (f) => exists(f), readFile: (f) => virtual.get(f) }
          const local = ts.resolveModuleName(spec, containingFile, compilerOptions, virtualHost)
          if (local.resolvedModule) return local
          if (root && !spec.startsWith('.') && !spec.startsWith('/')) {
            return ts.resolveModuleName(spec, path.join(root, '__pleatkit_typecheck__.ts'), { ...compilerOptions, paths: {}, baseUrl: undefined }, ts.sys)
          }
          return local
        }),
    }
    const dynamic = Object.keys(files).filter((p) => /\.(tsx|ts|jsx|js)$/.test(p) && input.context.dynamicRoots.some((r) => p.startsWith(r)))
    const program = ts.createProgram(
      dynamic.map((p) => '/' + p),
      compilerOptions,
      host,
    )
    const out: CompileError[] = []
    for (const p of dynamic) {
      const sf = program.getSourceFile('/' + p)
      if (!sf) continue
      for (const d of [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]) {
        if (IGNORED.has(d.code)) continue
        const { line, character } = d.start !== undefined ? sf.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 }
        out.push({ file: p, line: line + 1, column: character + 1, text: `${ts.flattenDiagnosticMessageText(d.messageText, ' ')} (TS${d.code}) [typecheck]`, rule: 'typecheck' })
        if (out.length >= 20) return out
      }
    }
    return out
  }
}

/** PLEATKIT_TYPECHECK=1 (+ PLEATKIT_TYPECHECK_ROOT) → a typechecker, else null. */
export function typecheckFromEnv(env: Record<string, string | undefined>): TypecheckFn | null {
  pleatkitEnv(env)
  if (env.PLEATKIT_TYPECHECK !== '1' && env.PLEATKIT_TYPECHECK !== 'true') return null
  const root = env.PLEATKIT_TYPECHECK_ROOT ?? null
  if (root && !fs.existsSync(root)) throw new Error(`PLEATKIT_TYPECHECK_ROOT ${root} does not exist`)
  return createTypechecker({ root })
}
