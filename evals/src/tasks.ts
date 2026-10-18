import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { trustedInput, type TrustedInput } from '@pleatkit/agent'
import type { AgentImage, AgentRunRequest, AgentVerdict, FileMap, PleatkitManifest } from '@pleatkit/runtime/compiler'
import { APPS, isAppId, manifestFile, type AppId } from './apps.js'
import type { EvalTask, FileRefMap } from './types.js'

export const EVALS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = path.resolve(EVALS_DIR, '..')
export const TASKS_DIR = path.join(EVALS_DIR, 'tasks')
/** The task suites: the demo's 14 (`evals/tasks`) and the foreign apps' (`evals/tasks/apps`, DECISIONS 73.1). */
export const SUITES = { demo: TASKS_DIR, apps: path.join(TASKS_DIR, 'apps') } as const
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
const VERDICTS: AgentVerdict[] = ['ok', 'partial', 'needs-backend', 'not-editable', 'declined', 'failed', 'clarify', 'refused']

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
    if (!c.testid && c.byText === undefined && c.textMatches === undefined && !c.within && !c.panel && !c.selector && !c.role) at(`invariants.browser.checks[${i}] needs testid, byText, within or panel`)
    if (c.panel && isAppId(t.app) && !Object.values(APPS[t.app].panels).flat().includes(c.panel)) at(`invariants.browser.checks[${i}].panel: ${c.panel} is not a panel of ${t.app}`)
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
export function prepareTask(task: EvalTask, manifest: PleatkitManifest): PreparedTask {
  const appId = `eval-${task.id}`
  const base = baseFiles(manifest)
  const start = { ...base, ...readRefs(task.startFiles ?? {}) }
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
  }
  const trusted = trustedInput(manifest, appId, body)
  const request: AgentRunRequest = { ...body, context: trusted.context, readonly: trusted.readonly, coreTypes: trusted.coreTypes, components: trusted.components }
  return { task, request, trusted, start }
}
