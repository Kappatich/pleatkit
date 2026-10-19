import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { globSync } from 'tinyglobby'
import { buildManifest, type PleatkitManifest, type PleatkitOptions } from '@pleatkit/vite-plugin'

export type Status = 'ok' | 'warn' | 'fail'

export interface Finding {
  id: 'config' | 'react' | 'panels' | 'release' | 'externals' | 'csp' | 'secrets' | 'secure-context' | 'context-budget' | 'zone-size'
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
  pleatkitOptions?: PleatkitOptions
  /** Where the app is served (`--url`): plain http:// on another host than localhost has no WebCrypto. */
  url?: string
  /** Environment (default process.env): PLEATKIT_API_KEY lets the context check count tokens with the API (free). */
  env?: Record<string, string | undefined>
  /** For tests: the agent package (default: `@pleatkit/agent` when installed), or null for none. */
  agent?: AgentModule | null
}

type AgentModule = Pick<typeof import('@pleatkit/agent'), 'Workspace' | 'trustedInput' | 'countPromptTokens' | 'sampleRequest' | 'formatErrors'> &
  // DECISIONS 75 Р2: optional, an older @pleatkit/agent has no expected cost
  Partial<Pick<typeof import('@pleatkit/agent'), 'expectedEditCost' | 'formatUsd' | 'DEFAULT_MODEL' | 'DEFAULT_CLASSIFIER_MODEL'>>

const loadAgent = async (): Promise<AgentModule | null> => (await import('@pleatkit/agent').catch(() => null)) as AgentModule | null

export interface LoadedConfig {
  file: string | null
  options: PleatkitOptions | null
  dedupe: string[]
  error?: string
  /** `server` / `preview` host and https of the Vite config (secure-context check). */
  served?: { host: string | boolean | undefined; https: boolean }
}

const CONFIG_FILES = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cts', 'vite.config.cjs']
const SCRIPT_EXT = ['.tsx', '.ts', '.jsx', '.js']

/** Load the app's vite.config with Vite itself and find the pleatkit plugin's options. */
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
    const plugin = plugins.find((p): p is { name: string; api?: { options?: PleatkitOptions } } => typeof p === 'object' && p !== null && (p as { name?: string }).name === 'pleatkit')
    const dedupe = loaded?.config.resolve?.dedupe ?? []
    const server = loaded?.config.server ?? {}
    return { file, options: plugin?.api?.options ?? null, dedupe, served: { host: server.host, https: Boolean(server.https) } }
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
  if (!appReact) return { id: 'react', status: 'fail', title: 'react is not installed in the app', details: [], fix: 'pnpm add react react-dom (React 18 or 19)' }
  const version = (JSON.parse(fs.readFileSync(appReact, 'utf8')) as { version: string }).version
  const details = [`app: react ${version}`]
  let status: Status = Number(version.split('.')[0]) >= 18 ? 'ok' : 'fail'
  let fix = status === 'fail' ? 'pleatkit needs React 18 or 19: pnpm add react@19 react-dom@19' : undefined
  const runtimePkg = realResolve(root, '@pleatkit/runtime/package.json')
  if (!runtimePkg) return { id: 'react', status: 'fail', title: '@pleatkit/runtime is not installed', details, fix: 'pnpm add @pleatkit/runtime @pleatkit/ui' }
  for (const name of ['react', 'react-dom']) {
    const fromApp = realResolve(root, `${name}/package.json`)
    const fromRuntime = realResolve(path.dirname(runtimePkg), `${name}/package.json`)
    if (fromApp && fromRuntime && fromApp !== fromRuntime) {
      details.push(`${name}: the app and @pleatkit/runtime resolve different copies (${path.dirname(fromApp)} vs ${path.dirname(fromRuntime)})`)
      if (dedupe.includes(name)) {
        details.push(`${name} is in resolve.dedupe, so Vite bundles one copy`)
        if (status === 'ok') status = 'warn'
      } else {
        status = 'fail'
        fix = "two Reacts break hooks: add resolve: { dedupe: ['react', 'react-dom'] } to vite.config (needed when pleatkit is linked from a local checkout)"
      }
    }
  }
  return { id: 'react', status, title: status === 'ok' ? 'one copy of React' : status === 'warn' ? 'two copies of React on disk, deduplicated by Vite' : 'React problem', details, ...(fix ? { fix } : {}) }
}

// --- <Dynamic id> panels ---

const DYNAMIC_ID = /<Dynamic\b[^>]*?\bid=(?:"([^"]+)"|'([^']+)'|\{\s*["'`]([^"'`]+)["'`]\s*\})/g
const HAS_DEFAULT = /export\s+default\b|export\s*\{[^}]*\bas\s+default\b[^}]*\}/

/** Every `<Dynamic id="x">` in the app's sources must have `<dynamic root>/x.(tsx|ts|jsx|js)` with a default export. */
export function checkPanels(root: string, manifest: PleatkitManifest): Finding {
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
export function checkExternals(root: string, manifest: PleatkitManifest): Finding {
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
  // stage 5 block 5 (found by a blind install): the configured list (`externalPatterns`, with `/*` entries) and the
  // modules it expands to (`externals`) are counted apart, and a `/*` entry that matches no module is reported
  const patterns = manifest.externalPatterns ?? manifest.externals
  const empty = patterns.filter((p) => p.endsWith('/*') && !manifest.externals.some((e) => e.startsWith(p.slice(0, -1))))
  const counted = `${patterns.length} entr${patterns.length === 1 ? 'y' : 'ies'} (${manifest.externals.length} module${manifest.externals.length === 1 ? '' : 's'})`
  if (missing.length) return { id: 'externals', status: 'fail', title: `${missing.length} external${missing.length > 1 ? 's do' : ' does'} not resolve`, details: missing, fix: 'install the package or fix the path, or remove it from `externals` in the pleatkit plugin options' }
  if (empty.length) return { id: 'externals', status: 'warn', title: `${empty.length} externals entr${empty.length === 1 ? 'y matches' : 'ies match'} no module: ${empty.join(', ')}`, details: [`${counted} resolve`], fix: `create the folder's modules (for example src/readonly/<name>.ts), or remove the entry` }
  return { id: 'externals', status: 'ok', title: `${counted} resolve`, details: [] }
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

/**
 * Problems of one policy for pleatkit. `browser` compile mode needs blob: modules, WebAssembly and a blob:
 * worker; `server` mode (the default, V1 B1) only needs the page's own origin for scripts.
 */
export function cspProblems(policy: string, compile: 'server' | 'browser' = 'browser'): string[] {
  const csp = parseCsp(policy)
  const script = csp.get('script-src') ?? csp.get('default-src')
  const worker = csp.get('worker-src') ?? csp.get('child-src') ?? script
  const problems: string[] = []
  if (compile === 'server') {
    if (script && !script.includes("'self'") && !script.includes('*')) problems.push("script-src needs 'self' (signed edits load from /pleatkit/b/ on the app's origin)")
    return problems
  }
  if (script) {
    if (!script.includes('blob:')) problems.push("script-src needs blob: (edits load as blob: modules)")
    if (!script.includes("'wasm-unsafe-eval'") && !script.includes("'unsafe-eval'")) problems.push("script-src needs 'wasm-unsafe-eval' (the compiler is WebAssembly)")
  }
  if (worker && !worker.includes('blob:')) problems.push('worker-src needs blob:')
  return problems
}

const RECOMMENDED_CSP = {
  browser: "script-src 'self' blob: 'wasm-unsafe-eval'; worker-src blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'",
  server: "script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
}

/** DECISIONS 63.1: does this source list (img-src, or default-src) let images load from `https://<host>`? */
export function cspAllowsHost(sources: string[], host: string): boolean {
  return sources.some((raw) => {
    const s = raw.toLowerCase()
    if (s === '*' || s === 'https:') return true
    const m = /^(?:https?:\/\/)?(\*\.)?([a-z0-9.-]+)(?::(\d+|\*))?(?:\/\S*)?$/.exec(s)
    if (!m || (m[3] && m[3] !== '443' && m[3] !== '*')) return false
    return m[1] ? host.endsWith(`.${m[2]}`) : host === m[2]
  })
}

/**
 * Look for a CSP in index.html and in common hosting files, and check it against what pleatkit needs. With
 * `allowedHosts` in the manifest (DECISIONS 63.1), `img-src` should list each of them, and nothing else is widened.
 */
export function checkCsp(root: string, isolated: boolean, compile: 'server' | 'browser' = 'server', allowedHosts: string[] = []): Finding {
  const recommended = RECOMMENDED_CSP[compile]
  const imgSrc = `img-src 'self' ${allowedHosts.map((h) => `https://${h}`).join(' ')}`
  const found: { where: string; policy: string }[] = []
  const html = path.join(root, 'index.html')
  if (fs.existsSync(html)) {
    // content="…" may hold single quotes ('self') and the other way round
    const meta = /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*content=(?:"([^"]*)"|'([^']*)')/i.exec(fs.readFileSync(html, 'utf8'))
    if (meta) found.push({ where: 'index.html <meta>', policy: (meta[1] ?? meta[2])! })
  }
  for (const rel of ['public/_headers', '_headers', 'vercel.json', 'netlify.toml']) {
    const file = path.join(root, rel)
    if (!fs.existsSync(file)) continue
    const m = /Content-Security-Policy["']?\s*[:=,]\s*["']?(?:value["']?\s*:\s*["'])?([^"'\n]+)/i.exec(fs.readFileSync(file, 'utf8'))
    if (m) found.push({ where: rel, policy: m[1]! })
  }
  const hints = isolated ? ['isolated panels: serve assets/pleatkit-isolated-host-*.js with Access-Control-Allow-Origin: *'] : []
  if (allowedHosts.length) hints.push(`allowedHosts in the manifest: ${allowedHosts.join(', ')} (images from them need ${imgSrc})`)
  if (found.length === 0) {
    return { id: 'csp', status: 'ok', title: 'no Content-Security-Policy found in the app', details: [`if you add one, pleatkit (compile: '${compile}') needs: ${recommended}${allowedHosts.length ? `; ${imgSrc}` : ''}`, ...hints] }
  }
  const problems = found.flatMap((f) => cspProblems(f.policy, compile).map((p) => `${f.where}: ${p}`))
  // an img-src (or default-src) that leaves out an allowed host: those images will not load (a warning, not a block)
  const blocked = found.flatMap((f) => {
    const csp = parseCsp(f.policy)
    const img = csp.get('img-src') ?? csp.get('default-src')
    return img ? allowedHosts.filter((h) => !cspAllowsHost(img, h)).map((h) => `${f.where}: img-src does not allow https://${h} (allowedHosts): images from it will not load`) : []
  })
  if (problems.length) return { id: 'csp', status: 'fail', title: 'the Content-Security-Policy blocks runtime edits', details: [...problems, ...blocked, ...hints], fix: `use at least: ${recommended}` }
  if (blocked.length) return { id: 'csp', status: 'warn', title: 'the Content-Security-Policy blocks images from allowedHosts', details: [...blocked, ...hints], fix: `add each allowed host to img-src: ${imgSrc}` }
  return { id: 'csp', status: 'ok', title: `CSP allows runtime edits (${found.map((f) => f.where).join(', ')})`, details: hints }
}

// --- context budget (brainstorm 04 §1, §8 item 12) ---

/**
 * Rough token count of code for budgeting: about 2.2 characters per token (DECISIONS 73.5: counted with the API on
 * the demo and the two foreign apps, 2.1 to 2.5; the old 3.5 underestimated an app's prefix by 40 %).
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 2.2)
/** The agent's own instructions and tool definitions, tokens (counted with the API on PROMPT_VERSION 2026-10-18.5a). */
export const INSTRUCTION_TOKENS = 3_500
export const CACHED_TARGET = 20_000
export const TAIL_TARGET = 6_000

/**
 * What one edit sends to the model: the cached prefix (instructions, tools, readonly sources, core types,
 * digests) and the tail (the dynamic files and the request). Targets: prefix 20k, tail 6k tokens; over them the
 * edits cost more and the model sees more noise.
 */
export function estimateContextTokens(manifest: PleatkitManifest): { cached: number; tail: number; readonly: number; types: number; digests: number } {
  const sum = (files: { source: string }[]) => files.reduce((s, f) => s + estimateTokens(f.source), 0)
  // DECISIONS 74.6: with an agent context the prompt holds its declarations, not every readonly source and core type
  const ctx = manifest.agentContext
  const readonly = ctx ? sum(ctx.files) : sum(manifest.readonly)
  const types = ctx ? 0 : sum(manifest.coreTypes)
  const digests = estimateTokens((manifest.designSystem?.digest ?? '') + (manifest.designSystem?.docs ?? '') + (manifest.dataContracts?.digest ?? ''))
  return { cached: INSTRUCTION_TOKENS + readonly + types + digests, tail: sum(manifest.dynamic) + 200, readonly, types, digests }
}

export function checkContextBudget(manifest: PleatkitManifest): Finding {
  const ctx = manifest.agentContext
  const { cached, tail, readonly, types, digests } = estimateContextTokens(manifest)
  const biggest = (ctx ? ctx.files : [...manifest.readonly, ...manifest.coreTypes])
    .map((f) => ({ path: f.path, tokens: estimateTokens(f.source) }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3)
  const details = [
    `cached prefix ≈ ${cached.toLocaleString('en')} tokens (instructions ${INSTRUCTION_TOKENS}, ${ctx ? `agent context ${readonly} (${ctx.files.length} declaration files the panels reach${ctx.omitted.length ? `, ${ctx.omitted.length} left out over the cap` : ''})` : `readonly ${readonly}, core types ${types}`}, digests ${digests}); target ≤ ${CACHED_TARGET.toLocaleString('en')}`,
    `tail ≈ ${tail.toLocaleString('en')} tokens (${manifest.dynamic.length} dynamic files and the request); target ≤ ${TAIL_TARGET.toLocaleString('en')}`,
    ...(biggest.length ? [`largest in the prefix: ${biggest.map((b) => `${b.path} (${b.tokens})`).join(', ')}`] : []),
  ]
  const over = cached > CACHED_TARGET || tail > TAIL_TARGET
  return over
    ? { id: 'context-budget', status: 'warn', title: 'the context of one edit is larger than the target', details, fix: 'move large files out of readonly (the agent sees core files as .d.ts only), split big dynamic files into one panel per file, or list fewer externals' }
    : { id: 'context-budget', status: 'ok', title: `context of one edit: ≈${cached.toLocaleString('en')} cached + ${tail.toLocaleString('en')} per request tokens`, details }
}

// --- zone size (stage 5 block 5, brainstorm 17 §3) ---

/**
 * The cost of an edit against the size of the dynamic zone, measured on shadcn-admin (sets zone-1, zone-3, zone-7:
 * 5 edits each, Sonnet 5.5, prompt 5i, the prefix read from the cache): every edit sends every dynamic file, so a
 * one-call edit costs about `ZONE_BASE_USD` plus `ZONE_USD_PER_LINE` for each line of the zone (medians $0.0103 at
 * 30–110 lines, $0.0143 at 170, $0.0300 at 813). Over `ZONE_LINES_TARGET` lines the zone's code costs more than the
 * rest of the edit and a one-call edit passes $0.02; over `PANEL_LINES_TARGET` one panel is most of that.
 */
export const ZONE_BASE_USD = 0.0085
export const ZONE_USD_PER_LINE = 0.0000256
export const ZONE_LINES_TARGET = 450
export const PANEL_LINES_TARGET = 300
const linesOf = (source: string) => source.split('\n').length

export function checkZoneSize(manifest: Pick<PleatkitManifest, 'dynamic'>): Finding {
  const files = manifest.dynamic.map((f) => ({ path: f.path, lines: linesOf(f.source) })).sort((a, b) => b.lines - a.lines)
  const total = files.reduce((n, f) => n + f.lines, 0)
  const edit = ZONE_BASE_USD + ZONE_USD_PER_LINE * total
  const big = files.filter((f) => f.lines > PANEL_LINES_TARGET)
  const details = [
    `${files.length} dynamic files, ${total.toLocaleString('en')} lines; every edit sends all of them: a one-call edit costs about $${edit.toFixed(4)} with Sonnet 5.5 ($${ZONE_BASE_USD} + $${(ZONE_USD_PER_LINE * 1000).toFixed(4)} per 1,000 lines of the zone, measured)`,
    `largest: ${files.slice(0, 3).map((f) => `${f.path} (${f.lines})`).join(', ')}`,
    `zones under ${ZONE_LINES_TARGET} lines keep a one-call edit under $${(ZONE_BASE_USD + ZONE_USD_PER_LINE * ZONE_LINES_TARGET).toFixed(3)}`,
  ]
  if (total > ZONE_LINES_TARGET || big.length) {
    return {
      id: 'zone-size',
      status: 'warn',
      title: total > ZONE_LINES_TARGET ? `the dynamic zone is ${total.toLocaleString('en')} lines: its code costs more than the rest of each edit` : `${big.length} panel${big.length > 1 ? 's are' : ' is'} over ${PANEL_LINES_TARGET} lines`,
      details: [...details, ...big.map((f) => `${f.path}: ${f.lines} lines`)],
      fix: `keep in the zone only the panels users change, and split a panel over ${PANEL_LINES_TARGET} lines (a table and its columns, a card and its parts) so the parts users never change can stay outside it`,
    }
  }
  return { id: 'zone-size', status: 'ok', title: `dynamic zone of ${total.toLocaleString('en')} lines: a one-call edit ≈ $${edit.toFixed(4)}`, details }
}

/**
 * DECISIONS 73.5: the same budget counted by the API's token counter (`count_tokens`, free) when PLEATKIT_API_KEY is
 * set and `@pleatkit/agent` is installed: the exact prompt the agent server builds for this app. Otherwise, or when the
 * counter is not reachable, the estimate above.
 */
export async function measureContextBudget(manifest: PleatkitManifest, env: Record<string, string | undefined>, agent: AgentModule | null): Promise<Finding> {
  const estimate = checkContextBudget(manifest)
  const key = env.PLEATKIT_API_KEY
  const estimated = (note: string): Finding => {
    const e = estimateContextTokens(manifest)
    return { ...estimate, details: [...estimate.details, note, ...expectedCostLine({ prefixTokens: e.cached, tailTokens: e.tail }, env.PLEATKIT_MODEL, env, agent, 'estimated')] }
  }
  if (!key || !agent) {
    return estimated(key ? 'estimated: install @pleatkit/agent to count with the API' : 'estimated (about 2.2 characters per token); with PLEATKIT_API_KEY set, doctor counts with the API token counter (free)')
  }
  try {
    const c = await agent.countPromptTokens(manifest, { apiKey: key, ...(env.PLEATKIT_BASE_URL ? { baseURL: env.PLEATKIT_BASE_URL } : {}), ...(env.PLEATKIT_MODEL ? { model: env.PLEATKIT_MODEL } : {}) })
    const over = c.prefixTokens > CACHED_TARGET || c.tailTokens > TAIL_TARGET
    const details = [
      `cached prefix ${c.prefixTokens.toLocaleString('en')} tokens (tools, instructions, digests, ${manifest.agentContext ? 'the agent context' : 'readonly sources, core types'}), counted by the API for ${c.model}, prompt ${c.promptVersion}; target ≤ ${CACHED_TARGET.toLocaleString('en')}`,
      `tail ${c.tailTokens.toLocaleString('en')} tokens (${manifest.dynamic.length} dynamic files and a short request); target ≤ ${TAIL_TARGET.toLocaleString('en')}`,
      ...estimate.details.filter((d) => d.startsWith('largest in the prefix')),
      ...expectedCostLine(c, c.model, env, agent, 'counted'),
    ]
    const title = `context of one edit: ${c.prefixTokens.toLocaleString('en')} cached + ${c.tailTokens.toLocaleString('en')} per request tokens (counted)`
    return over ? { id: 'context-budget', status: 'warn', title: `the context of one edit is larger than the target (${c.prefixTokens.toLocaleString('en')} cached + ${c.tailTokens.toLocaleString('en')} per request tokens, counted)`, details, fix: estimate.fix ?? 'move large files out of readonly' } : { id: 'context-budget', status: 'ok', title, details }
  } catch (e) {
    return estimated(`estimated: the API token counter failed (${(e as Error).message.split('\n')[0]!.slice(0, 160)})`)
  }
}

/**
 * DECISIONS 75 Р2: "Expected cost per edit on this app: $X (cold: $Y)" from the prompt size and the model price table
 * (`expectedEditCost` of @pleatkit/agent), for the model the agent server would use (PLEATKIT_MODEL, else the default)
 * and its classifier. Nothing when the agent package is too old to compute it.
 */
function expectedCostLine(size: { prefixTokens: number; tailTokens: number }, model: string | undefined, env: Record<string, string | undefined>, agent: AgentModule | null, how: 'counted' | 'estimated'): string[] {
  if (!agent?.expectedEditCost || !agent.formatUsd) return []
  const main = model ?? agent.DEFAULT_MODEL ?? 'claude-sonnet-5-5'
  const anthropic = !env.PLEATKIT_PROVIDER || env.PLEATKIT_PROVIDER === 'anthropic'
  const classifier = env.PLEATKIT_CLASSIFIER_MODEL ?? (anthropic ? (agent.DEFAULT_CLASSIFIER_MODEL ?? 'claude-haiku-5-5') : main)
  const e = agent.expectedEditCost(size, main, classifier)
  if (e.expectedUsd === null || e.coldUsd === null) return [`Expected cost per edit on this app: unknown (no price for ${e.unpriced.join(', ')})`]
  const a = e.assumptions
  return [
    `Expected cost per edit on this app: ${agent.formatUsd(e.expectedUsd)} (cold: ${agent.formatUsd(e.coldUsd)}) with ${main} and the ${classifier} classifier`,
    `  from the ${how} prompt size: prefix read from the cache, tail written to it, ${a.outputTokens} output tokens, a second call in ${Math.round(a.twoCallShare * 100)} % of edits; cold: the first edit after 5 minutes idle`,
  ]
}

// --- the release's own panels pass check (stage 5, foreign apps) ---

/**
 * Every edit is checked with the whole dynamic zone, so a panel of the release that the check refuses (an `<img src>`
 * taken from data, a computed URL) makes every edit fail ("Something went wrong on our side"). Runs the agent
 * server's check on the release's files when `@pleatkit/agent` is installed.
 */
export async function checkRelease(manifest: PleatkitManifest, agent: AgentModule | null): Promise<Finding> {
  if (!agent) return { id: 'release', status: 'warn', title: 'the panels were not checked: @pleatkit/agent is not installed', details: [], fix: 'pnpm add -D @pleatkit/agent (install.md step 2), then run doctor again' }
  const req = agent.sampleRequest(manifest)
  const trusted = agent.trustedInput(manifest, 'doctor', req)
  const ws = new agent.Workspace({ ...req, protected: trusted.protected, base: trusted.base })
  const r = await ws.check()
  if (r.ok) return { id: 'release', status: 'ok', title: `the release's ${manifest.dynamic.length} dynamic file${manifest.dynamic.length === 1 ? ' passes' : 's pass'} the agent's check (compile and static rules)`, details: [] }
  const text = agent.formatErrors(r.errors)
  return {
    id: 'release',
    status: 'fail',
    title: `the release's own panels do not pass the agent's check: every edit would be refused`,
    details: text.split('\n').slice(0, 8),
    fix: releaseFix(text),
  }
}

/** Block 6 (blind install antd-6): the advice follows the rules that fired, not always the URL one. */
export function releaseFix(errors: string): string {
  const tips: string[] = []
  if (/createElement|no-raw-html/.test(errors)) tips.push('write JSX instead of React.createElement: a component passed as a prop renders as const { icon: Icon } = props; <Icon />')
  if (/url|href|src=|no-external|navigation/i.test(errors)) tips.push('an image or link URL from data: build it from a relative path written in the code, e.g. src={`/images/${row.file}`}')
  if (/no-portal|createPortal|document\.body/.test(errors)) tips.push('render inside the panel instead of a portal (the UI kit\'s own popovers in readonly code are fine)')
  return `change these lines in the dynamic files${tips.length ? ` (${tips.join('; ')})` : ''}; see troubleshooting.md "Every edit fails"`
}

// --- secure context (code review 06 item 4) ---

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|.*\.localhost)$/i

/**
 * WebCrypto (`crypto.subtle`) exists only in secure contexts: https://, or http://localhost. On a plain http://
 * intranet host pleatkit falls back to JS hashing (slower), and signed bundles (`publicKey`) cannot be verified,
 * so their edits are refused and the original version is shown.
 */
export function checkSecureContext(url: string | undefined, served: LoadedConfig['served'], publicKey: boolean): Finding {
  const details: string[] = []
  let insecure = false
  if (url) {
    try {
      const u = new URL(url)
      insecure = u.protocol === 'http:' && !LOCAL.test(u.hostname)
      details.push(`${u.origin}: ${insecure ? 'not a secure context (no crypto.subtle)' : 'secure context'}`)
    } catch {
      details.push(`--url ${url} is not a URL`)
    }
  } else if (served && served.host && served.host !== 'localhost' && !served.https) {
    insecure = true
    details.push(`the dev server is exposed on ${served.host === true ? 'all interfaces' : served.host} over plain http: other machines get no crypto.subtle`)
  }
  if (!insecure) return { id: 'secure-context', status: 'ok', title: url ? 'served from a secure context' : 'no insecure origin found (pass --url to check a deployment)', details }
  if (publicKey) {
    return { id: 'secure-context', status: 'fail', title: 'signed bundles cannot be verified on plain http', details, fix: 'serve the app over https (or localhost): with publicKey set, edits are refused without WebCrypto' }
  }
  return { id: 'secure-context', status: 'warn', title: 'plain http: hashing falls back to JavaScript', details, fix: 'serve the app over https; pleatkit works on http but slower, and production auth (tokens, signed bundles) needs https' }
}

// --- secrets in the client bundle ---

const KEY_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'OpenRouter API key', re: /sk-or-v1-[A-Za-z0-9]{20,}/g },
  { name: 'OpenAI API key', re: /sk-(?!ant-|or-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { name: 'pleatkit app key', re: /mk_live_[A-Za-z0-9]{16,}/g },
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
    return { id: 'secrets', status: 'fail', title: 'a key can reach the browser', details: leaks, fix: 'remove the key from client code and VITE_ variables; keep it only in the environment of the agent server (PLEATKIT_API_KEY), then rotate it' }
  }
  if (!fs.existsSync(dist)) {
    return { id: 'secrets', status: 'warn', title: `no build to scan (${path.relative(root, dist) || dist})`, details: ['.env files checked'], fix: 'run your build (vite build), then run pleatkit doctor again' }
  }
  return { id: 'secrets', status: 'ok', title: `no API keys in the client bundle (${scanned} files scanned)`, details: [] }
}

// --- all together ---

export async function doctor(options: DoctorOptions): Promise<Finding[]> {
  const root = path.resolve(options.root)
  const dist = path.resolve(root, options.dist ?? 'dist')
  const findings: Finding[] = []
  const config: LoadedConfig = options.pleatkitOptions ? { file: null, options: options.pleatkitOptions, dedupe: ['react', 'react-dom'] } : await loadViteConfig(root)
  if (!config.options) {
    findings.push({
      id: 'config',
      status: 'fail',
      title: config.error ? `could not load the Vite config: ${config.error}` : `no pleatkit plugin in ${path.basename(config.file ?? 'vite.config')}`,
      details: [],
      fix: "add pleatkit({ zones: { dynamic: ['src/dynamic/**'] }, externals: [...] }) to plugins in vite.config (see docs/for-agents/install.md)",
    })
  } else {
    const zones = config.options.zones
    findings.push({ id: 'config', status: 'ok', title: `pleatkit plugin found${config.file ? ` in ${path.basename(config.file)}` : ''}`, details: [`dynamic: ${zones.dynamic.join(', ')}`, `readonly: ${(zones.readonly ?? []).join(', ') || '(none)'}`] })
  }
  findings.push(checkReact(root, config.dedupe))
  let allowedHosts: string[] = []
  if (config.options) {
    let manifest: PleatkitManifest | null = null
    try {
      manifest = buildManifest(root, config.options)
    } catch (e) {
      findings.push({ id: 'panels', status: 'fail', title: `could not read the zones: ${(e as Error).message.split('\n')[0]}`, details: [] })
    }
    if (manifest) {
      allowedHosts = manifest.allowedHosts ?? []
      if (manifest.dynamic.length === 0) {
        findings.push({ id: 'panels', status: 'fail', title: `the dynamic zone (${config.options.zones.dynamic.join(', ')}) has no files`, details: [], fix: 'move the panels users may change into src/dynamic/<id>.tsx' })
      } else findings.push(checkPanels(root, manifest))
      const agent = options.agent === undefined ? await loadAgent() : options.agent
      if (manifest.dynamic.length) findings.push(await checkRelease(manifest, agent).catch((e: Error) => ({ id: 'release' as const, status: 'warn' as const, title: `the panels could not be checked: ${e.message.split('\n')[0]}`, details: [] })))
      findings.push(checkExternals(root, manifest))
      findings.push(await measureContextBudget(manifest, options.env ?? process.env, agent))
      findings.push(checkZoneSize(manifest))
    }
  }
  findings.push(checkCsp(root, Boolean(config.options?.isolated), config.options?.compile ?? 'server', allowedHosts))
  findings.push(checkSecureContext(options.url, config.served, Boolean(config.options?.publicKey ?? process.env.PLEATKIT_PUBLIC_KEY)))
  findings.push(checkSecrets(root, dist))
  return findings
}

const MARK: Record<Status, string> = { ok: '[ok]  ', warn: '[warn]', fail: '[FAIL]' }

export function formatFindings(findings: Finding[], root: string): string {
  const lines = [`pleatkit doctor: ${root}`, '']
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
