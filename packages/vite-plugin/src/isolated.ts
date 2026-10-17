import path from 'node:path'
import { createRequire } from 'node:module'
import { build, type Plugin as EsbuildPlugin } from 'esbuild'
import { aliasToPath, type MorphkitManifest } from './manifest.js'

/**
 * Build the script that runs inside the sandboxed iframe of an `isolated` panel: React, every external the
 * dynamic zone may import, the original dynamic modules and the host bootstrap from @morphkit/runtime.
 * It is a single classic script so it can be inlined into `srcdoc` (an opaque-origin frame cannot fetch
 * module chunks from the app without CORS).
 */
export async function buildIsolatedHost(root: string, manifest: MorphkitManifest, minify: boolean): Promise<string> {
  const req = createRequire(path.join(root, 'package.json'))
  const imports: string[] = []
  const externals: string[] = []
  const fallback: string[] = []
  manifest.externals.forEach((spec, i) => {
    imports.push(`import * as e${i} from ${JSON.stringify(spec)}`)
    externals.push(`${JSON.stringify(spec)}: e${i}`)
  })
  manifest.dynamic
    .filter((f) => /\.(tsx|ts|jsx|js)$/.test(f.path))
    .forEach((f, i) => {
      imports.push(`import * as f${i} from ${JSON.stringify('./' + f.path)}`)
      fallback.push(`${JSON.stringify(f.path)}: f${i}`)
    })
  const entry = [
    ...imports,
    `import { startIsolatedHost } from '@morphkit/runtime/isolated-host'`,
    `startIsolatedHost({ externals: { ${externals.join(', ')} }, fallback: { ${fallback.join(', ')} }, dynamicRoots: ${JSON.stringify(manifest.dynamicRoots)} })`,
  ].join('\n')

  const resolveFromApp: EsbuildPlugin = {
    name: 'morphkit-isolated-resolve',
    setup(b) {
      // One React for the whole frame: always the app's copy.
      b.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) => ({ path: req.resolve(args.path) }))
      b.onResolve({ filter: /.*/ }, async (args) => {
        const rel = aliasToPath(args.path, manifest.alias)
        if (rel === null || args.pluginData === 'aliased') return undefined
        const r = await b.resolve('./' + rel, { resolveDir: root, kind: args.kind, pluginData: 'aliased' })
        return r.errors.length ? { errors: r.errors } : { path: r.path }
      })
    },
  }

  const result = await build({
    stdin: { contents: entry, resolveDir: root, loader: 'js', sourcefile: 'morphkit-isolated-entry.js' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    minify,
    legalComments: 'none',
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify(minify ? 'production' : 'development') },
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
    plugins: [resolveFromApp],
  })
  return result.outputFiles[0]?.text ?? ''
}
