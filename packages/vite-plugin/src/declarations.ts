import path from 'node:path'
import ts from 'typescript'
import type { ManifestFile } from './manifest.js'

const toPosix = (p: string): string => p.split(path.sep).join('/')

/** Emit `.d.ts` text for the given project files (paths relative to root). */
export function emitDeclarations(root: string, files: string[], alias: Record<string, string>): ManifestFile[] {
  if (files.length === 0) return []
  const paths: Record<string, string[]> = {}
  for (const [key, dir] of Object.entries(alias)) paths[`${key}/*`] = [`${dir.replace(/\/$/, '')}/*`]

  const options: ts.CompilerOptions = {
    declaration: true,
    emitDeclarationOnly: true,
    skipLibCheck: true,
    strict: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    baseUrl: root,
    paths,
    rootDir: root,
    outDir: path.join(root, '__pleatkit_types__'),
    noEmitOnError: false,
  }
  const absFiles = files.map((f) => path.join(root, f))
  const program = ts.createProgram(absFiles, options)
  const outDir = toPosix(options.outDir!)
  const out: ManifestFile[] = []
  for (const abs of absFiles) {
    const sf = program.getSourceFile(abs)
    if (!sf) continue
    program.emit(
      sf,
      (fileName, text) => {
        if (!fileName.endsWith('.d.ts')) return
        out.push({ path: toPosix(fileName).slice(outDir.length + 1), source: text })
      },
      undefined,
      true,
    )
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}
