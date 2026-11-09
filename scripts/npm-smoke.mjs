#!/usr/bin/env node
// Fresh-install smoke of the public packages, as a user gets them from npm: a new `create vite@7` React app, the npm
// route of docs/for-agents/install.md (steps 2 to 7, with examples/t1-vite's panel, readonly module and recorded
// agent answer), `pnpm build`, `pleatkit doctor`, then one chat edit headless against the dev server and against
// `vite preview` (scripted provider, no model key; store-server in memory). Never publishes anything.
//
//   node scripts/npm-smoke.mjs --from packed     before a release: builds and packs the six packages (pnpm pack replaces
//                                                the workspace: ranges) and installs the tarballs
//   node scripts/npm-smoke.mjs --from registry   after a release: installs @pleatkit/*@<version> from npm
//
// Options: --dir <folder> (default: <os tmp>/pleatkit-npm-smoke; it is emptied first), --version <x.y.z> (default: the
// version in packages/runtime/package.json). Needs Node 22, pnpm 10 and the repository's own install (Playwright
// comes from apps/demo-crm). Ports 5173, 4173, 8789 and 8790 must be free. Exit code 0 only when every check passed.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const from = arg('--from', 'packed')
if (!['packed', 'registry'].includes(from)) {
  console.error('--from must be packed or registry')
  process.exit(2)
}
const version = arg('--version', JSON.parse(fs.readFileSync(path.join(repo, 'packages/runtime/package.json'), 'utf8')).version)
const dir = path.resolve(arg('--dir', path.join(os.tmpdir(), 'pleatkit-npm-smoke')))
const PACKAGES = ['runtime', 'ui', 'vite-plugin', 'agent', 'cli', 'store-server']
const shell = process.platform === 'win32'
const example = path.join(repo, 'examples/t1-vite')
const app = path.join(dir, 'app')
const pack = path.join(dir, 'pack')

function run(cmd, args, cwd, { quiet = false, env = {} } = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}   (${cwd})`)
  const r = spawnSync(cmd, args, { cwd, shell, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (!quiet) process.stdout.write(out.split('\n').filter((l) => !/^Progress:/.test(l)).join('\n'))
  if (r.status !== 0) {
    if (quiet) process.stdout.write(out.split('\n').slice(-40).join('\n'))
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`)
  }
  return out
}
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')

const results = []
try {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })

  // the packages
  const spec = (name) => (from === 'packed' ? path.join(pack, `pleatkit-${name}-${version}.tgz`).replace(/\\/g, '/') : `@pleatkit/${name}@${version}`)
  if (from === 'packed') {
    run('pnpm', ['build:packages'], repo, { quiet: true })
    fs.mkdirSync(pack)
    for (const name of PACKAGES) run('pnpm', ['pack', '--pack-destination', pack], path.join(repo, 'packages', name), { quiet: true })
    for (const name of PACKAGES) if (!fs.existsSync(spec(name))) throw new Error(`no tarball ${spec(name)}`)
  }

  // a fresh app (install.md step 0)
  run('pnpm', ['create', 'vite@7', 'app', '--template', 'react-ts', '--no-rolldown', '--no-immediate'], dir, { quiet: true })
  if (from === 'packed') {
    // the tarballs name each other at the release version, which the registry does not have yet: point those at the files
    const pkg = json(path.join(app, 'package.json'))
    pkg.pnpm = { overrides: Object.fromEntries(PACKAGES.map((name) => [`@pleatkit/${name}`, `file:${spec(name)}`])) }
    writeJson(path.join(app, 'package.json'), pkg)
  }
  run('pnpm', ['install'], app, { quiet: true })

  // step 2 A
  const added1 = run('pnpm', ['add', spec('runtime'), spec('ui')], app)
  const added2 = run('pnpm', ['add', '-D', '--allow-build=better-sqlite3', ...['vite-plugin', 'agent', 'cli', 'store-server'].map(spec), '@types/node@^22', 'tailwindcss@^4', '@tailwindcss/vite@^4'], app)
  const listed = PACKAGES.filter((name) => new RegExp(`\\+ @pleatkit/${name} ${version.replace(/\./g, '\\.')}`).test(added1 + added2))
  results.push([listed.length === PACKAGES.length, `step 2: ${listed.length}/6 packages at ${version} (${from})`])
  const peers = /unmet peer|Issues with peer dependencies/i.test(added1 + added2)
  results.push([!peers, `step 2: ${peers ? 'unmet peer dependencies (see above)' : 'no unmet peer dependencies'}`])

  // steps 3 to 6: the example's panel, readonly module, entry and recorded answer; the config of install.md step 3
  for (const f of ['src/assets', 'src/App.css']) fs.rmSync(path.join(app, f), { recursive: true, force: true })
  for (const f of ['src/App.tsx', 'src/index.css', 'src/dynamic', 'src/readonly', 'fixtures', 'scripts/smoke.mjs']) fs.cpSync(path.join(example, f), path.join(app, f), { recursive: true })
  const main = path.join(app, 'src/main.tsx')
  fs.writeFileSync(main, fs.readFileSync(path.join(example, 'src/main.tsx'), 'utf8').replace(`appId: 't1-vite'`, `appId: 'npm-smoke'`))
  // install.md step 3 as written for an npm install: no resolve.dedupe
  fs.writeFileSync(
    path.join(app, 'vite.config.ts'),
    fs
      .readFileSync(path.join(example, 'vite.config.ts'), 'utf8')
      .replace(/\n\s*\/\/ one React for the app[^\n]*\n\s*dedupe: \[[^\]]*\],/, ''),
  )
  if (fs.readFileSync(path.join(app, 'vite.config.ts'), 'utf8').includes('dedupe')) throw new Error('vite.config.ts still has resolve.dedupe')
  const tsconfig = path.join(app, 'tsconfig.app.json')
  fs.writeFileSync(
    tsconfig,
    fs.readFileSync(tsconfig, 'utf8').replace('"jsx": "react-jsx",', '"jsx": "react-jsx",\n    "types": ["vite/client", "@pleatkit/vite-plugin/client"],\n    "paths": { "@/*": ["./src/*"] },'),
  )
  const pkg = json(path.join(app, 'package.json'))
  pkg.scripts = { ...pkg.scripts, agent: 'pleatkit-agent', store: 'pleatkit-store' }
  writeJson(path.join(app, 'package.json'), pkg)

  const build = run('pnpm', ['build'], app, { quiet: true })
  results.push([/built in/.test(build) && fs.existsSync(path.join(app, 'dist/pleatkit.manifest.json')), 'step 6: tsc -b && vite build, dist/pleatkit.manifest.json'])
  const doctor = run('pnpm', ['exec', 'pleatkit', 'doctor'], app)
  results.push([/all checks passed/.test(doctor) && !/\[FAIL\]/.test(doctor), 'pleatkit doctor: no [FAIL]'])

  // step 7 and verify.md: store-server, the agent (scripted), ping and one chat edit, on the dev server and on preview
  const env = { PLEATKIT_PLAYWRIGHT_FROM: path.join(repo, 'apps/demo-crm/package.json') }
  for (const mode of ['--dev', '--preview']) {
    let out = ''
    let ok = true
    try {
      out = run('node', ['scripts/smoke.mjs', '--browser', ...(mode === '--dev' ? ['--dev'] : [])], app, { env })
    } catch {
      ok = false
    }
    ok &&= /\[ok\]\s+chat edit in the browser: applied/.test(out) && /\[ok\]\s+after a reload/.test(out)
    results.push([ok, `step 7: one chat edit ${mode === '--dev' ? 'on the dev server (vite)' : 'on vite preview'}, kept after a reload`])
  }
} catch (e) {
  results.push([false, e.message])
}

console.log(`\nnpm smoke (${from}, ${version}) in ${dir}`)
for (const [ok, line] of results) console.log(`[${ok ? 'ok' : 'FAIL'}]   ${line}`)
const failed = results.filter(([ok]) => !ok).length
console.log(failed ? `\nnpm smoke FAILED: ${failed} problem(s)` : '\nnpm smoke passed')
process.exit(failed ? 1 : 0)
