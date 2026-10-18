#!/usr/bin/env node
// Release check (DECISIONS 71): everything that must hold before a release is tagged, without publishing.
//
//   node scripts/release-check.mjs            build, tests, the version matrix, package metadata, dry-run publish
//   node scripts/release-check.mjs --quick    the version matrix, metadata and dry-run publish only (after a build)
//
// It never publishes: the only publish it runs is `pnpm -r publish --dry-run --no-git-checks`, which must list every
// public package at the release version and none of the private ones. Exit code 1 when anything fails.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const quick = process.argv.includes('--quick')
const problems = []
const ok = (line) => console.log(`[ok]   ${line}`)
const fail = (line) => {
  problems.push(line)
  console.log(`[FAIL] ${line}`)
}
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))

function run(label, cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (r.status === 0) ok(label)
  else fail(`${label} (exit ${r.status}): ${out.trim().split('\n').slice(-15).join('\n')}`)
  return out
}

// --- the packages ---
// the workspace (pnpm-workspace.yaml: packages/*, apps/*, evals)
const dirs = ['packages', 'apps'].flatMap((top) => fs.readdirSync(path.join(root, top)).map((d) => `${top}/${d}`)).concat(['evals'])
const pkgs = dirs.filter((d) => fs.existsSync(path.join(root, d, 'package.json'))).map((d) => ({ dir: d, json: read(`${d}/package.json`) }))
const pub = pkgs.filter((p) => !p.json.private)
const priv = pkgs.filter((p) => p.json.private)
console.log(`public:  ${pub.map((p) => `${p.json.name}@${p.json.version}`).join(', ')}`)
console.log(`private: ${priv.map((p) => p.json.name).join(', ')}`)

// --- the version matrix ---
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
const release = /^## (\d+\.\d+\.\d+)\b/m.exec(changelog)?.[1]
if (!release) fail('CHANGELOG.md has no "## x.y.z" release heading')
else ok(`CHANGELOG.md names release ${release}`)
for (const p of pub) {
  if (p.json.version === release) ok(`${p.json.name} is ${release}`)
  else fail(`${p.json.name} is ${p.json.version}, the release is ${release} (${p.dir}/package.json)`)
}
const constants = [
  ['packages/cli/src/cli.ts', /const VERSION = '([^']+)'/, '@pleatkit/cli'],
  ['packages/vite-plugin/src/index.ts', /export const PLUGIN_VERSION = '([^']+)'/, '@pleatkit/vite-plugin'],
]
for (const [file, re, name] of constants) {
  const v = re.exec(fs.readFileSync(path.join(root, file), 'utf8'))?.[1]
  const want = pub.find((p) => p.json.name === name)?.json.version
  if (v === want) ok(`${file} reports ${v}`)
  else fail(`${file} reports ${v}, ${name} is ${want}`)
}
// a public package may depend on another pleatkit package only through the workspace (published as the same version)
for (const p of pub) {
  for (const field of ['dependencies', 'peerDependencies']) {
    for (const [dep, range] of Object.entries(p.json[field] ?? {})) {
      if (!dep.startsWith('@pleatkit/')) continue
      if (priv.some((q) => q.json.name === dep)) fail(`${p.json.name} ${field} on the private ${dep}`)
      else if (!String(range).startsWith('workspace:')) fail(`${p.json.name} ${field}.${dep} is "${range}", not workspace:`)
    }
  }
}

// --- package metadata ---
for (const p of pub) {
  const j = p.json
  const where = `${j.name}:`
  const errs = []
  if (j.license !== 'MIT') errs.push(`license is ${j.license}`)
  if (j.publishConfig?.access !== 'public') errs.push('publishConfig.access is not public')
  if (j.repository?.url !== 'git+https://github.com/Kappatich/pleatkit.git' || j.repository?.directory !== p.dir) errs.push('repository is not Kappatich/pleatkit with this directory')
  if (!Array.isArray(j.files) || !j.files.includes('dist')) errs.push('files does not include dist')
  for (const f of ['README.md', 'LICENSE']) if (!fs.existsSync(path.join(root, p.dir, f))) errs.push(`no ${f}`)
  if (!j.exports?.['.']) errs.push('no exports["."]')
  for (const bin of Object.keys(j.bin ?? {})) if (/morphkit/.test(bin)) errs.push(`old binary ${bin}`)
  if (errs.length) fail(`${where} ${errs.join('; ')}`)
  else ok(`${where} license, publishConfig, repository, files, README, LICENSE`)
}
for (const p of priv) {
  if (p.json.publishConfig) fail(`${p.json.name} is private but has publishConfig`)
}

// --- build and tests ---
if (!quick) {
  run('pnpm build', 'pnpm', ['build'])
  run('pnpm test', 'pnpm', ['test'])
}

// every export target exists after the build, and no pre-rename name ships (DECISIONS 69)
const targets = (e) => (typeof e === 'string' ? [e] : e && typeof e === 'object' ? Object.values(e).flatMap(targets) : [])
for (const p of pub) {
  const missing = targets(p.json.exports).filter((t) => !fs.existsSync(path.join(root, p.dir, t)))
  if (missing.length) fail(`${p.json.name}: exports point at missing files (build first): ${missing.join(', ')}`)
  const dist = path.join(root, p.dir, 'dist')
  const hits = fs.existsSync(dist)
    ? fs
        .readdirSync(dist, { recursive: true })
        .filter((f) => /\.(js|d\.ts)$/.test(String(f)))
        .filter((f) => /\bMorphkit|\bMORPHKIT_|virtual:morphkit|x-morphkit-/.test(fs.readFileSync(path.join(dist, String(f)), 'utf8')))
    : []
  if (hits.length) fail(`${p.json.name}: pre-rename names in ${hits.join(', ')}`)
  else if (!missing.length) ok(`${p.json.name}: exports resolve, no pre-rename names in dist`)
}

// --- dry-run publish ---
const out = run('pnpm -r publish --dry-run --no-git-checks', 'pnpm', ['-r', 'publish', '--dry-run', '--no-git-checks'])
const listed = [...out.matchAll(/^\+ (@pleatkit\/[\w-]+)@(\S+)$/gm)].map((m) => ({ name: m[1], version: m[2] }))
for (const p of pub) {
  const hit = listed.find((l) => l.name === p.json.name)
  if (!hit) fail(`dry-run publish did not list ${p.json.name}`)
  else if (hit.version !== release) fail(`dry-run publish lists ${hit.name}@${hit.version}, the release is ${release}`)
  else ok(`dry-run publish: ${hit.name}@${hit.version}`)
}
for (const p of priv) {
  if (listed.some((l) => l.name === p.json.name)) fail(`dry-run publish would publish the private ${p.json.name}`)
  else ok(`dry-run publish skips the private ${p.json.name}`)
}

console.log(problems.length ? `\nrelease check FAILED: ${problems.length} problem(s)` : `\nrelease check passed: ${pub.length} public packages at ${release}, nothing published`)
process.exit(problems.length ? 1 : 0)
