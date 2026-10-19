import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { manifestPanels, trustedInput, type TrustedInput } from '@pleatkit/agent'
import type { AgentImage, AgentRunRequest, AgentVerdict, FileMap, PleatkitManifest } from '@pleatkit/runtime/compiler'
import { APPS, isAppId, manifestFile, type AppId } from './apps.js'
import type { EvalTask, FileRefMap } from './types.js'

export const EVALS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = path.resolve(EVALS_DIR, '..')
export const TASKS_DIR = path.join(EVALS_DIR, 'tasks')
/** The task suites: the demo's 14 (`evals/tasks`) and the foreign apps' (`evals/tasks/apps`, DECISIONS 73.1). */
export const SUITES = {
  demo: TASKS_DIR,
  apps: path.join(TASKS_DIR, 'apps'),
  /** DECISIONS 75 Р3: requests as irritated users write them (typos, mixed languages, vague, two asks, …). */
  awkward: path.join(TASKS_DIR, 'awkward'),
  /** DECISIONS 75 Р3: 30 attacks, zero tolerance (static rules, the runtime guard and the model's judgement). */
  redteam: path.join(TASKS_DIR, 'redteam'),
  /** Stage 5 block 5: the two blind-installed apps (antd-dashboard, mesa), 8 tasks each. */
  blind: path.join(TASKS_DIR, 'blind'),
} as const
export type Suite = keyof typeof SUITES
export const RECORDINGS_DIR = path.join(EVALS_DIR, 'recordings')
export const RESULTS_DIR = path.join(EVALS_DIR, 'results')
/** The baseline of the live series (DECISIONS 67.1: pinned on the first live run). */
export const BASELINE_FILE = path.join(EVALS_DIR, 'baseline.json')
/** The baseline of the scripted transcripts (`evals/recordings/*.jsonl`): what plain `pnpm eval:replay` checks. */
export const SCRIPTED_BASELINE_FILE = path.join(EVALS_DIR, 'baseline.scripted.json')
/** A named set of transcripts: `evals/recordings/<set>/`; no set is the scripted transcripts. */
export const setDir = (set?: string): string => (set ? path.join(RECORDINGS_DIR, set) : RECORDINGS_DIR)
/** The baseline a set is compared with: `live` → baseline.json, none → baseline.scripted.json, other → baseline.<set>.json. */
export const baselineFileOf = (set?: string): string => (!set ? SCRIPTED_BASELINE_FILE : set === 'live' ? BASELINE_FILE : path.join(EVALS_DIR, `baseline.${set}.json`))
export const REPORT_FILE = path.join(EVALS_DIR, 'report', 'index.html')
export const DEMO_DIR = path.join(REPO_ROOT, 'apps', 'demo-crm')
export const DEMO_MANIFEST = path.join(DEMO_DIR, 'dist', 'pleatkit.manifest.json')
/** Scripted fixtures that play the agent for offline recordings: the demo's e2e fixtures and the eval-only ones. */
export const FIXTURE_DIRS = [path.join(DEMO_DIR, 'e2e', 'fixtures', 'agent'), path.join(EVALS_DIR, 'fixtures', 'scripted')]

export const DEFAULT_TASK_BUDGET_USD = 0.5
const VERDICTS: AgentVerdict[] = ['ok', 'partial', 'needs-backend', 'not-editable', 'declined', 'failed', 'clarify', 'refused', 'restore']

export const repoPath = (p: string): string => (path.isAbsolute(p) ? p : path.join(REPO_ROOT, p))
const read = (p: string): string => fs.readFileSync(repoPath(p), 'utf8')
export const readRefs = (refs: FileRefMap): FileMap => Object.fromEntries(Object.entries(refs).map(([k, v]) => [k, read(v)]))

/** Problems of a task definition; empty when it is valid. Paths are checked against the repository. */
export function validateTask(t: Partial<EvalTask>, file = '(task)'): string[] {
  const p: string[] = []
  const at = (m: string) => p.push(`${file}: ${m}`)
  if (!t.id || !/^[a-z0-9][a-z0-9-]*$/.test(t.id)) at('id must be lower-case letters, digits and dashes')
  if (!isAppId(t.app)) at(`app must be one of ${Object.keys(APPS).join(', ')}`)
  if (!t.title) at('title is required')
  if (!t.request || !t.request.trim()) at('request is required')
  if (!t.expected || !VERDICTS.includes(t.expected.verdict)) at(`expected.verdict must be one of ${VERDICTS.join(', ')}`)
  if (t.expected && typeof t.expected.change !== 'boolean') at('expected.change must be true or false')
  for (const [i, a] of (t.expected?.alsoAccept ?? []).entries()) if (!VERDICTS.includes(a.verdict) || typeof a.change !== 'boolean') at(`expected.alsoAccept[${i}] needs a verdict and change`)
  if (t.expected?.change && !t.reference) at('a task that requires a change needs a reference solution')
  if (t.budgetUsd !== undefined && !(t.budgetUsd > 0)) at('budgetUsd must be a positive number')
  const refs: [string, FileRefMap | undefined][] = [
    ['reference.files', t.reference?.files],
    ['startFiles', t.startFiles],
    ['migration.edited', t.migration?.edited],
  ]
  for (const [name, map] of refs) for (const [k, v] of Object.entries(map ?? {})) if (!fs.existsSync(repoPath(v))) at(`${name}["${k}"]: ${v} does not exist`)
  for (const img of t.images ?? []) if (!fs.existsSync(repoPath(img))) at(`images: ${img} does not exist`)
  for (const [i, c] of (t.invariants?.browser?.checks ?? []).entries()) {
    if (!c.launcherOnTop && !c.containedInPanel && !c.testid && c.byText === undefined && c.textMatches === undefined && !c.within && !c.panel && !c.selector && !c.role) at(`invariants.browser.checks[${i}] needs testid, byText, within or panel`)
    if (c.panel && isAppId(t.app) && !Object.values(APPS[t.app].panels).flat().includes(c.panel)) at(`invariants.browser.checks[${i}].panel: ${c.panel} is not a panel of ${t.app}`)
    if (c.containedInPanel && isAppId(t.app) && !Object.values(APPS[t.app].panels).flat().includes(c.containedInPanel)) at(`invariants.browser.checks[${i}].containedInPanel: ${c.containedInPanel} is not a panel of ${t.app}`)
  }
  const classRes = (t.invariants?.browser?.checks ?? []).flatMap((c) => [c.classMatches, c.textMatches, c.matches, c.name, c.css?.matches].filter((x): x is string => typeof x === 'string'))
  for (const re of [...(t.invariants?.forbidden ?? []), ...(t.invariants?.files ?? []).flatMap((f) => [...(f.mustMatch ?? []), ...(f.mustNotMatch ?? [])]), ...(t.invariants?.anyMustMatch ?? []), ...classRes]) {
    try {
      new RegExp(re, 'm')
    } catch {
      at(`invalid regular expression ${re}`)
    }
  }
  return p
}

export function loadTasks(dir = TASKS_DIR, only?: string[]): EvalTask[] {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  const tasks: EvalTask[] = []
  const problems: string[] = []
  for (const f of files) {
    const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as EvalTask
    problems.push(...validateTask(t, f))
    tasks.push(t)
  }
  const ids = new Set<string>()
  for (const t of tasks) {
    if (ids.has(t.id)) problems.push(`duplicate task id ${t.id}`)
    ids.add(t.id)
  }
  if (problems.length) throw new Error(`Invalid eval tasks:\n${problems.join('\n')}`)
  return only?.length ? tasks.filter((t) => only.some((o) => t.id === o || t.id.startsWith(o))) : tasks
}

/** Tasks of several suites (`demo`, `apps`), in that order. */
export function loadSuites(suites: Suite[], only?: string[]): EvalTask[] {
  return suites.flatMap((s) => (fs.existsSync(SUITES[s]) ? loadTasks(SUITES[s], only) : []))
}

export function loadManifest(file = DEMO_MANIFEST, app: AppId = 'demo-crm'): PleatkitManifest {
  if (!fs.existsSync(file)) throw new Error(`${path.relative(REPO_ROOT, file)} is missing: run "${APPS[app].build}" first (the eval tasks run against the app's build manifest).`)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as PleatkitManifest
}

/** The build manifest of every app the tasks use. */
export function loadManifests(tasks: Pick<EvalTask, 'app'>[]): Partial<Record<AppId, PleatkitManifest>> {
  const apps = [...new Set(tasks.map((t) => t.app))]
  return Object.fromEntries(apps.map((a) => [a, loadManifest(manifestFile(a), a)]))
}

export const baseFiles = (m: PleatkitManifest): FileMap => Object.fromEntries(m.dynamic.map((f) => [f.path, f.source]))

const imageType = (p: string): AgentImage['mediaType'] => (/\.jpe?g$/i.test(p) ? 'image/jpeg' : /\.webp$/i.test(p) ? 'image/webp' : /\.gif$/i.test(p) ? 'image/gif' : 'image/png')

export interface PreparedTask {
  task: EvalTask
  request: AgentRunRequest
  trusted: TrustedInput
  /** Files the user starts from (the request's `files`). */
  start: FileMap
}

/**
 * The request the agent server would build for this task: everything the server trusts comes from the demo's
 * build manifest (`trustedInput`), exactly as `POST /agent/v1/run` does it.
 */
export function prepareTask(task: EvalTask, manifest: PleatkitManifest, startFiles?: FileMap, revert?: AgentRunRequest['revert']): PreparedTask {
  const appId = `eval-${task.id}`
  const base = baseFiles(manifest)
  // an edit chain (DECISIONS 75 Р3) starts each step from the previous step's files, held in memory
  const start = startFiles ? { ...startFiles } : { ...base, ...readRefs(task.startFiles ?? {}) }
  let migration: AgentRunRequest['migration']
  if (task.migration) {
    const oldBase = Object.fromEntries(Object.entries(base).map(([p, s]) => [p, s + task.migration!.oldBaseSuffix]))
    migration = { oldBase, edited: { ...oldBase, ...readRefs(task.migration.edited) } }
  }
  const body: AgentRunRequest = {
    userId: 'eval',
    appId,
    locale: task.locale ?? 'en',
    request: task.request,
    files: start,
    readonly: {},
    coreTypes: {},
    context: { alias: manifest.alias, externals: manifest.externals, externalPatterns: manifest.externalPatterns, dynamicRoots: manifest.dynamicRoots },
    components: [],
    ...(task.target ? { target: task.target } : {}),
    ...(task.targetDom ? { targetDom: task.targetDom } : {}),
    ...(task.images?.length ? { images: task.images.map((p) => ({ mediaType: imageType(p), data: fs.readFileSync(repoPath(p)).toString('base64'), name: path.basename(p) })) } : {}),
    ...(task.clarification ? { clarification: task.clarification } : {}),
    ...(migration ? { migration } : {}),
    ...(revert ? { revert } : {}),
  }
  // block 6 (DECISIONS 84.5, 17 §14): `--point` (PLEATKIT_EVAL_POINT=1) points at the panel the task's reference changes
  // when the task points at none, as a user clicking the panel would; `--panel-shots <dir>` (PLEATKIT_EVAL_PANEL_SHOTS)
  // attaches `<dir>/<task>.before.png` (the browser grader's "before" screenshot of that panel) as the target image
  if (process.env.PLEATKIT_EVAL_POINT === '1' && !body.target && !migration && !revert) {
    const ref = Object.keys(task.reference?.files ?? {}).find((p) => manifestPanels(manifest).includes(p))
    if (ref) body.target = ref.replace(/^.*\//, '').replace(/\.\w+$/, '')
  }
  const shots = process.env.PLEATKIT_EVAL_PANEL_SHOTS
  if (shots && body.target) {
    const shot = path.join(shots, `${task.id}.before.png`)
    if (fs.existsSync(shot)) body.targetImage = { mediaType: 'image/png', data: fs.readFileSync(shot).toString('base64'), name: path.basename(shot) }
  }
  const trusted = trustedInput(manifest, appId, body)
  const zone = Number(process.env.PLEATKIT_EVAL_ZONE_FILES ?? 0)
  if (zone > 0 && !startFiles) {
    // stage 5 block 5 (brainstorm 17 §3): the cost of an edit against the size of the zone. The zone keeps `zone`
    // dynamic files: the ones the task's reference changes, then the other panels of the same route, then the rest
    const keep = zoneOf(task, Object.keys(start), zone)
    for (const p of Object.keys(start)) if (!keep.has(p)) delete start[p]
    trusted.components = trusted.components.filter((c) => keep.has(c))
    trusted.base = Object.fromEntries(Object.entries(trusted.base).filter(([p]) => keep.has(p)))
  }
  const request: AgentRunRequest = { ...body, files: start, context: trusted.context, readonly: trusted.readonly, coreTypes: trusted.coreTypes, components: trusted.components }
  return { task, request, trusted, start }
}

/** The `n` dynamic files a zone of that size keeps for a task (`PLEATKIT_EVAL_ZONE_FILES`). */
export function zoneOf(task: Pick<EvalTask, 'app' | 'reference' | 'target'>, files: string[], n: number): Set<string> {
  const refs = Object.keys(task.reference?.files ?? {}).filter((p) => files.includes(p))
  const idOf = (p: string) => p.replace(/^.*\//, '').replace(/\.\w+$/, '')
  const target = task.target ?? (refs[0] ? idOf(refs[0]) : undefined)
  const routes = Object.values(APPS[task.app].panels)
  const sameRoute = new Set(routes.find((ids) => target && ids.includes(target)) ?? [])
  const rank = (p: string) => (refs.includes(p) ? 0 : sameRoute.has(idOf(p)) ? 1 : 2)
  return new Set([...files].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, n))
}
