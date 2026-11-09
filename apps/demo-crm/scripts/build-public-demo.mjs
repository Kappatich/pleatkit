// Build the public demo release (docs/demo-hosting.md): a self-contained folder with
//   server.mjs      the demo server (server/public/main.ts) bundled with the agent, store-server and runtime
//   web/            the built app (vite build), with pleatkit.manifest.json
//   fixtures/       the recorded agent answers and the panels they load
//   package.json    the few packages that cannot be bundled (native: better-sqlite3, esbuild; read from disk at run
//                   time: tailwindcss, typescript, @types/react), installed on the server with `npm install --omit=dev`
//   deploy/         the systemd unit and the nginx vhost
// Usage: node scripts/build-public-demo.mjs [outDir]   (default: $DEMO_RELEASE_DIR or D:/pleatkit-tmp/demo-release,
// falling back to the system temp folder). Run `vite build` first (scripts/deploy-demo.sh does both).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(app, '..', '..')
const fallback = fs.existsSync('D:/') ? 'D:/pleatkit-tmp/demo-release' : path.join(os.tmpdir(), 'pleatkit-demo-release')
const out = path.resolve(process.argv[2] ?? process.env.DEMO_RELEASE_DIR ?? fallback)

// esbuild comes with the agent package (pnpm keeps it out of this app's own dependencies)
const esbuild = createRequire(path.join(repo, 'packages', 'agent', 'package.json'))('esbuild')

const web = path.join(app, 'dist')
if (!fs.existsSync(path.join(web, 'pleatkit.manifest.json'))) {
  console.error('build-public-demo: apps/demo-crm/dist has no pleatkit.manifest.json; run `pnpm --filter @pleatkit/demo-crm build` first')
  process.exit(1)
}

/** Exact versions of what stays outside the bundle, taken from the workspace's own installs. */
const EXTERNAL = {
  'better-sqlite3': path.join(repo, 'packages', 'store-server'),
  esbuild: path.join(repo, 'packages', 'agent'),
  typescript: path.join(repo, 'packages', 'agent'),
  tailwindcss: path.join(repo, 'packages', 'agent'),
  '@types/react': app,
}
const versions = Object.fromEntries(
  Object.entries(EXTERNAL).map(([name, from]) => [name, JSON.parse(fs.readFileSync(createRequire(path.join(from, 'package.json')).resolve(`${name}/package.json`), 'utf8')).version]),
)

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await esbuild.build({
  entryPoints: [path.join(app, 'server', 'public', 'main.ts')],
  outfile: path.join(out, 'server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  legalComments: 'none',
  // native or read from node_modules at run time; esbuild-wasm is the browser compiler, never loaded on the server
  external: [...Object.keys(EXTERNAL), 'esbuild-wasm', 'esbuild-wasm/*', '@tailwindcss/*'],
  // CommonJS dependencies inside an ES module bundle still call require()
  banner: { js: "import { createRequire as __pkCreateRequire } from 'node:module'; const require = __pkCreateRequire(import.meta.url);" },
  logLevel: 'warning',
})

fs.cpSync(web, path.join(out, 'web'), { recursive: true })
fs.cpSync(path.join(app, 'e2e', 'fixtures'), path.join(out, 'fixtures'), { recursive: true })
fs.mkdirSync(path.join(out, 'deploy'), { recursive: true })
for (const f of ['pleatkit-demo.service', 'demo.pleatkit.com.conf', 'demo.pleatkit.com.bootstrap.conf', 'env.example']) fs.copyFileSync(path.join(app, 'deploy', f), path.join(out, 'deploy', f))

const commit = process.env.DEMO_BUILD_COMMIT ?? 'unknown'
fs.writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'pleatkit-public-demo',
      private: true,
      type: 'module',
      description: 'demo.pleatkit.com: built by apps/demo-crm/scripts/build-public-demo.mjs',
      engines: { node: '>=22' },
      scripts: { start: 'node server.mjs' },
      dependencies: versions,
    },
    null,
    2,
  ) + '\n',
)
fs.writeFileSync(path.join(out, 'BUILD'), `built ${new Date().toISOString()} from ${commit}\n`)
console.log(`build-public-demo: ${out} (server.mjs ${(fs.statSync(path.join(out, 'server.mjs')).size / 1024 / 1024).toFixed(1)} MB; npm deps ${Object.entries(versions).map(([k, v]) => `${k}@${v}`).join(', ')})`)
