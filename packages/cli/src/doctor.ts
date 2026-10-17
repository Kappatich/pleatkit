import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { globSync } from 'tinyglobby'
import { buildManifest, type MorphkitManifest, type MorphkitOptions } from '@morphkit/vite-plugin'

export type Status = 'ok' | 'warn' | 'fail'

export interface Finding {
  id: 'config' | 'react' | 'panels' | 'externals' | 'csp' | 'secrets'
  status: Status
  title: string
  details: string[]
  /** What to do, when status is not ok. */
  fix?: string
}

export interface DoctorOptions {
  root: string
  /** Built client bundle to scan for secrets. Default `<root>/dist`. */
  dist?: string
  /** For tests: skip loading vite.config and use these options. */
  morphkitOptions?: MorphkitOptions
}

export interface LoadedConfig {
  file: string | null
  options: MorphkitOptions | null
  dedupe: string[]
  error?: string
}

const CONFIG_FILES = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cts', 'vite.config.cjs']
const SCRIPT_EXT = ['.tsx', '.ts', '.jsx', '.js']

/** Load the app's vite.config with Vite itself and find the morphkit plugin's options. */
export async function loadViteConfig(root: string): Promise<LoadedConfig> {
  const file = CONFIG_FILES.map((f) => path.join(root, f)).find((f) => fs.existsSync(f)) ?? null
  if (!file) return { file: null, options: null, dedupe: [], error: 'no vite.config.* in ' + root }
  try {
    // the app's own Vite when it has one, so its config loads exactly as in its build
    let vite: typeof import('vite')
    try {
      const fromApp = createRequire(path.join(root, 'package.json')).resolve('vite')
      vite = (await import(pathToFileURL(fromApp).href)) as typeof import('vite')
    } catch {
      vite = await import('vite')
    }
    const loaded = await vite.loadConfigFromFile({ command: 'build', mode: 'production' }, file, root, 'silent')
    const plugins = (loaded?.config.plugins ?? []).flat(Infinity as 1) as unknown[]
    const plugin = plugins.find((p): p is { name: string; api?: { options?: MorphkitOptions } } => typeof p === 'object' && p !== null && (p as { name?: string }).name === 'morphkit')
    const dedupe = loaded?.config.resolve?.dedupe ?? []
    return { file, options: plugin?.api?.options ?? null, dedupe }
  } catch (e) {
    return { file, options: null, dedupe: [], error: (e as Error).message.split('\n')[0] }
  }
}

// --- React duplicates ---

/**
 * `<name>/package.json` as Node would find it from `fromDir` (walking up node_modules), real path. Unlike
 * require.resolve this ignores NODE_PATH, which package managers set for their bin shims and which would
 * find packages the app itself cannot import.
 */
function realResolve(fromDir: string, spec: string): string | null {
  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!
  let dir = path.resolve(fromDir)
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name, 'package.json')
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate)
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

export function checkReact(root: string, dedupe: string[]): Finding {
  const appReact = realResolve(root, 'react/package.json')
  if (!appReact) return { id: 'react', status: 'fail', title: 'react is not installed in the app', details: [], fix: 'pnpm add react react-dom (React 19)' }
  const version = (JSON.parse(fs.readFileSync(appReact, 'utf8')) as { version: string }).version
  const details = [`app: react ${version}`]
  let status: Status = Number(version.split('.')[0]) >= 19 ? 'ok' : 'fail'
  let fix = status === 'fail' ? 'morphkit needs React 19: pnpm add react@19 react-dom@19' : undefined
  const runtimePkg = realResolve(root, '@morphkit/runtime/package.json')
  if (!runtimePkg) return { id: 'react', status: 'fail', title: '@morphkit/runtime is not installed', details, fix: 'pnpm add @morphkit/runtime @morphkit/ui' }
  for (const name of ['react', 'react-dom']) {
    const fromApp = realResolve(root, `${name}/package.json`)
    const fromRuntime = realResolve(path.dirname(runtimePkg), `${name}/package.json`)
    if (fromApp && fromRuntime && fromApp !== fromRuntime) {
      details.push(`${name}: the app and @morphkit/runtime resolve different copies (${path.dirname(fromApp)} vs ${path.dirname(fromRuntime)})`)
      if (dedupe.includes(name)) {
        details.push(`${name} is in resolve.dedupe, so Vite bundles one copy`)
        if (status === 'ok') status = 'warn'
      } else {
        status = 'fail'
        fix = "two Reacts break hooks: add resolve: { dedupe: ['react', 'react-dom'] } to vite.config (needed when morphkit is linked from a local checkout)"
      }
    }
  }
  return { id: 'react', status, title: status === 'ok' ? 'one copy of React' : status === 'warn' ? 'two copies of React on disk, deduplicated by Vite' : 'React problem', details, ...(fix ? { fix } : {}) }
}

// --- <Dynamic id> panels ---

const DYNAMIC_ID = /<Dynamic\b[^>]*?\bid=(?:"([^"]+)"|'([^']+)'|\{\s*["'`]([^"'`]+)["'`]\s*\})/g
const HAS_DEFAULT = /export\s+default\b|export\s*\{[^}]*\bas\s+default\b[^}]*\}/

/** Every `<Dynamic id="x">` in the app's sources must have `<dynamic root>/x.(tsx|ts|jsx|js)` with a default export. */
export function checkPanels(root: string, manifest: MorphkitManifest): Finding {
  const sources = globSync(['src/**/*.{tsx,jsx,ts,js}'], { cwd: root, ignore: ['**/node_modules/**', '**/*.d.ts'] })
  const ids = new Map<string, string>()
  for (const rel of sources) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8')
    for (const m of text.matchAll(DYNAMIC_ID)) ids.set(m[1] ?? m[2] ?? m[3]!, rel)
  }
  const dynamic = new Map(manifest.dynamic.map((f) => [f.path, f.source]))
  const problems: string[] = []
  const fixes: string[] = []
  for (const [id, usedIn] of ids) {
    const candidates = manifest.dynamicRoots.flatMap((r) => SCRIPT_EXT.map((e) => r + id + e))
    const file = candidates.find((c) => dynamic.has(c))
    if (!file) {
      problems.push(`<Dynamic id="${id}"> in ${usedIn}: no file ${manifest.dynamicRoots[0] ?? 'src/dynamic/'}${id}.tsx in the dynamic zone`)
      fixes.push(`create ${manifest.dynamicRoots[0] ?? 'src/dynamic/'}${id}.tsx with a default-exported component, or fix the id`)
    } else if (!HAS_DEFAULT.test(dynamic.get(file)!)) {
      problems.push(`${file} has no default export (mounted as <Dynamic id="${id}"> in ${usedIn})`)
      fixes.push(`add \`export default\` to the component in ${file}`)
    }
  }
  if (ids.size === 0) {
    return { id: 'panels', status: 'warn', title: 'no <Dynamic id="..."> found in src', details: [], fix: 'render the panels users may change as <Dynamic id="name" props={...} /> instead of importing them' }
  }
  return problems.length
    ? { id: 'panels', status: 'fail', title: `${problems.length} of ${ids.size} <Dynamic> panels are broken`, details: problems, fix: [...new Set(fixes)].join('; ') }
    : { id: 'panels', status: 'ok', title: `${ids.size} <Dynamic> panel${ids.size > 1 ? 's' : ''}, each with a file and a default export`, details: [...ids.keys()].map((id) => `<Dynamic id="${id}">`) }
}

// --- externals ---

function exists(base: string): boolean {
  return ['', ...SCRIPT_EXT, ...SCRIPT_EXT.map((e) => '/index' + e)].some((e) => fs.existsSync(base + e) && (e !== '' || fs.statSync(base).isFile()))
}

/** Every external the dynamic code may import must resolve: aliases to a file in the app, packages from node_modules. */
export function checkExternals(root: string, manifest: MorphkitManifest): Finding {
  const missing: string[] = []
  for (const spec of manifest.externals) {
    const alias = Object.entries(manifest.alias).find(([k]) => spec === k || spec.startsWith(k + '/'))
    if (alias) {
      const rel = alias[1].replace(/\/$/, '') + spec.slice(alias[0].length)
      if (!exists(path.join(root, rel))) missing.push(`${spec} → ${rel} (no such file)`)
    } else if (!realResolve(root, spec)) {
      missing.push(`${spec} (package not installed)`)
    }
  }
  return missing.length
    ? { id: 'externals', status: 'fail', title: `${missing.length} external${missing.length > 1 ? 's do' : ' does'} not resolve`, details: missing, fix: 'install the package or fix the path, or remove it from `externals` in the morphkit plugin options' }
    : { id: 'externals', status: 'ok', title: `${manifest.externals.length} externals resolve`, details: [] }
}

// --- CSP ---

export function parseCsp(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const part of policy.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/)
    if (name) out.set(name.toLowerCase(), values)
  }
  return out
}

/** Problems of one policy for morphkit: blob: modules, WebAssembly, a blob: worker. */
export function cspProblems(policy: string): string[] {
  const csp = parseCsp(policy)
  const script = csp.get('script-src') ?? csp.get('default-src')
  const worker = csp.get('worker-src') ?? csp.get('child-src') ?? script
  const problems: string[] = []
  if (script) {
    if (!script.includes('blob:')) problems.push("script-src needs blob: (edits load as blob: modules)")
    if (!script.includes("'wasm-unsafe-eval'") && !script.includes("'unsafe-eval'")) problems.push("script-src needs 'wasm-unsafe-eval' (the compiler is WebAssembly)")
  }
  if (worker && !worker.includes('blob:')) problems.push('worker-src needs blob:')
  return problems
}

const RECOMMENDED_CSP = "script-src 'self' blob: 'wasm-unsafe-eval'; worker-src blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'"

/** Look for a CSP in index.html and in common hosting files, and check it against what morphkit needs. */
export function checkCsp(root: string, isolated: boolean): Finding {
  const found: { where: string; policy: string }[] = []
  const html = path.join(root, 'index.html')
  if (fs.existsSync(html)) {
    const meta = /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*content=["']([^"']+)["']/i.exec(fs.readFileSync(html, 'utf8'))
    if (meta) found.push({ where: 'index.html <meta>', policy: meta[1]! })
  }
  for (const rel of ['public/_headers', '_headers', 'vercel.json', 'netlify.toml']) {
    const file = path.join(root, rel)
    if (!fs.existsSync(file)) continue
    const m = /Content-Security-Policy["']?\s*[:=,]\s*["']?(?:value["']?\s*:\s*["'])?([^"'\n]+)/i.exec(fs.readFileSync(file, 'utf8'))
    if (m) found.push({ where: rel, policy: m[1]! })
  }
  const hints = isolated ? ['isolated panels: serve assets/morphkit-isolated-host-*.js with Access-Control-Allow-Origin: *'] : []
  if (found.length === 0) {
    return { id: 'csp', status: 'ok', title: 'no Content-Security-Policy found in the app', details: [`if you add one, morphkit needs: ${RECOMMENDED_CSP}`, ...hints] }
  }
  const problems = found.flatMap((f) => cspProblems(f.policy).map((p) => `${f.where}: ${p}`))
  return problems.length
    ? { id: 'csp', status: 'fail', title: 'the Content-Security-Policy blocks runtime edits', details: [...problems, ...hints], fix: `use at least: ${RECOMMENDED_CSP}` }
    : { id: 'csp', status: 'ok', title: `CSP allows runtime edits (${found.map((f) => f.where).join(', ')})`, details: hints }
}

// --- secrets in the client bundle ---

const KEY_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'OpenRouter API key', re: /sk-or-v1-[A-Za-z0-9]{20,}/g },
  { name: 'OpenAI API key', re: /sk-(?!ant-|or-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { name: 'morphkit app key', re: /mk_live_[A-Za-z0-9]{16,}/g },
]
const SECRET_ENV = /^\s*(VITE_[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*)\s*=\s*\S/gm

const redact = (s: string) => `${s.slice(0, 7)}…${s.slice(-2)} (${s.length} chars)`

/** No model or app key may reach the browser: scan the built bundle and the VITE_ variables Vite exposes. */
export function checkSecrets(root: string, dist: string): Finding {
  const leaks: string[] = []
  for (const envFile of globSync(['.env', '.env.*'], { cwd: root, dot: true })) {
    if (envFile.endsWith('.example')) continue
    for (const m of fs.readFileSync(path.join(root, envFile), 'utf8').matchAll(SECRET_ENV)) {
      leaks.push(`${envFile}: ${m[1]} is a VITE_ variable, so Vite puts its value into the browser bundle`)
    }
  }
  let scanned = 0
  if (fs.existsSync(dist)) {
    for (const rel of globSync(['**/*.{js,mjs,html,json,map}'], { cwd: dist })) {
      const text = fs.readFileSync(path.join(dist, rel), 'utf8')
      scanned++
      for (const { name, re } of KEY_PATTERNS) for (const m of text.matchAll(re)) leaks.push(`${path.relative(root, path.join(dist, rel))}: ${name} ${redact(m[0])}`)
    }
  }
  if (leaks.length) {
    return { id: 'secrets', status: 'fail', title: 'a key can reach the browser', details: leaks, fix: 'remove the key from client code and VITE_ variables; keep it only in the environment of the agent server (MORPHKIT_API_KEY), then rotate it' }
  }
  if (!fs.existsSync(dist)) {
    return { id: 'secrets', status: 'warn', title: `no build to scan (${path.relative(root, dist) || dist})`, details: ['.env files checked'], fix: 'run your build (vite build), then run morphkit doctor again' }
  }
  return { id: 'secrets', status: 'ok', title: `no API keys in the client bundle (${scanned} files scanned)`, details: [] }
}

// --- all together ---

export async function doctor(options: DoctorOptions): Promise<Finding[]> {
  const root = path.resolve(options.root)
  const dist = path.resolve(root, options.dist ?? 'dist')
  const findings: Finding[] = []
  const config: LoadedConfig = options.morphkitOptions ? { file: null, options: options.morphkitOptions, dedupe: ['react', 'react-dom'] } : await loadViteConfig(root)
  if (!config.options) {
    findings.push({
      id: 'config',
      status: 'fail',
      title: config.error ? `could not load the Vite config: ${config.error}` : `no morphkit plugin in ${path.basename(config.file ?? 'vite.config')}`,
      details: [],
      fix: "add morphkit({ zones: { dynamic: ['src/dynamic/**'] }, externals: [...] }) to plugins in vite.config (see docs/for-agents/install.md)",
    })
  } else {
    const zones = config.options.zones
    findings.push({ id: 'config', status: 'ok', title: `morphkit plugin found${config.file ? ` in ${path.basename(config.file)}` : ''}`, details: [`dynamic: ${zones.dynamic.join(', ')}`, `readonly: ${(zones.readonly ?? []).join(', ') || '(none)'}`] })
  }
  findings.push(checkReact(root, config.dedupe))
  if (config.options) {
    let manifest: MorphkitManifest | null = null
    try {
      manifest = buildManifest(root, config.options)
    } catch (e) {
      findings.push({ id: 'panels', status: 'fail', title: `could not read the zones: ${(e as Error).message.split('\n')[0]}`, details: [] })
    }
    if (manifest) {
      if (manifest.dynamic.length === 0) {
        findings.push({ id: 'panels', status: 'fail', title: `the dynamic zone (${config.options.zones.dynamic.join(', ')}) has no files`, details: [], fix: 'move the panels users may change into src/dynamic/<id>.tsx' })
      } else findings.push(checkPanels(root, manifest))
      findings.push(checkExternals(root, manifest))
    }
  }
  findings.push(checkCsp(root, Boolean(config.options?.isolated)))
  findings.push(checkSecrets(root, dist))
  return findings
}

const MARK: Record<Status, string> = { ok: '[ok]  ', warn: '[warn]', fail: '[FAIL]' }

export function formatFindings(findings: Finding[], root: string): string {
  const lines = [`morphkit doctor: ${root}`, '']
  for (const f of findings) {
    lines.push(`${MARK[f.status]} ${f.id}: ${f.title}`)
    for (const d of f.details) lines.push(`         ${d}`)
    if (f.fix && f.status !== 'ok') lines.push(`         fix: ${f.fix}`)
  }
  const fails = findings.filter((f) => f.status === 'fail').length
  const warns = findings.filter((f) => f.status === 'warn').length
  lines.push('', fails ? `${fails} problem${fails > 1 ? 's' : ''}, ${warns} warning${warns === 1 ? '' : 's'}` : warns ? `no problems, ${warns} warning${warns === 1 ? '' : 's'}` : 'all checks passed')
  return lines.join('\n')
}
