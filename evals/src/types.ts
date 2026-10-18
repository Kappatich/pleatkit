import type { AgentResult, AgentVerdict, UsageByModel } from '@pleatkit/runtime/compiler'
import type { AppId } from './apps.js'

export type { AppId } from './apps.js'

/** Dynamic path → repo-relative path of the file with its content (`apps/demo-crm/e2e/fixtures/…`). */
export type FileRefMap = Record<string, string>

/** Text checks on one file of the result (base files with the agent's changes applied). */
export interface FileInvariant {
  path: string
  /** Literal substrings that must be present (existing data-testid attributes, the panel's props). */
  mustContain?: string[]
  mustNotContain?: string[]
  /** Regular expressions (JavaScript syntax, flag `m`). */
  mustMatch?: string[]
  mustNotMatch?: string[]
}

/** One check in the rendered demo app, after the result is committed in a headless browser. */
export interface BrowserCheck {
  /**
   * `data-testid` of the element. Use it for ids the app documents (the demo's panel conventions: data fields keep
   * `data-testid` equal to the field name); for anything else check text or behaviour (`byText`, `contains`).
   */
  testid?: string
  /** The element whose whole text is this, any case (inside `within`, or inside `testid` when both are given). */
  byText?: string
  /** The elements whose text matches this regular expression (any case). */
  textMatches?: string
  /** A CSS selector inside the scope (`thead th`, `.recharts-line`): structure the user sees, never a test id. */
  selector?: string
  /** An ARIA role inside the scope (`button`), with `name` a regular expression on its accessible name. */
  role?: string
  name?: string
  /** `data-testid` of the panel to look in (default: the whole page). */
  within?: string
  /** `<Dynamic id>` of the panel to look in (a foreign app's panels have no test ids of their own). */
  panel?: string
  /** Exact number of matching elements (0: must not exist). Default: at least one, the first is checked. */
  count?: number
  /** Exact text of the first match. */
  text?: string
  /** Substring of the text of the first match. */
  contains?: string
  /** Text the first match must not contain. */
  notContains?: string
  /** Regular expression the first match's whole text must match (any case): order of rows, a computed value. */
  matches?: string
  /** Substring of the first match's class attribute. */
  class?: string
  /** Regular expression a class attribute of the first match or of an element inside it must match (`text-(red|destructive)`). */
  classMatches?: string
  /** `around`: `classMatches` may also be on an ancestor up to the panel (a struck-through row). Default: the element and inside it. */
  classScope?: 'self' | 'around'
  /** A computed style of the first match and a regular expression its value must match (`font-weight`, `^[6-9]00`). */
  css?: { prop: string; matches: string }
  /** The first match is at most this tall, CSS pixels (a compact layout). */
  maxHeight?: number
  /** An attribute of the first match and its exact value. */
  attr?: { name: string; value: string }
  /** Click the first match after its checks; later checks see the result (a filter button, a tab). */
  click?: boolean
}

export interface BrowserInvariants {
  /** Demo app: customer selected in the list before the checks (a substring of the button's name). Default "Globex". */
  customer?: string
  /** Route the checks run on (`/users`); default: the route of the task's target panel, else the app's start page. */
  path?: string
  checks: BrowserCheck[]
}

export interface TaskInvariants {
  files?: FileInvariant[]
  /** Regular expressions none of the changed files may match (forbidden patterns). */
  forbidden?: string[]
  /** Dynamic files the agent must not change. */
  unchanged?: string[]
  /** Regular expressions each of which some dynamic file of the result must match (the agent picks the file). */
  anyMustMatch?: string[]
  /** Names of custom predicates (`src/predicates.ts`). */
  predicates?: string[]
  browser?: BrowserInvariants
}

/** One eval task (`evals/tasks/*.json`). */
export interface EvalTask {
  id: string
  /** App the task runs against (`evals/src/apps.ts`). */
  app: AppId
  title: string
  /** Which demo scenario it covers (free text, shown in the report). */
  scenario?: string
  request: string
  locale?: 'en' | 'ru'
  /** Panel the user pointed at (`customer-card`): the classifier is skipped. */
  target?: string
  /** DOM snapshot of the pointed panel as the browser would send it. */
  targetDom?: string
  /** Screenshots (repo-relative PNG/JPEG paths). */
  images?: string[]
  /** The user's answer to the one clarifying question. */
  clarification?: { question: string; answer: string }
  /** The user's current version, if not the release's original files. */
  startFiles?: FileRefMap
  /**
   * Stale carry-over: the old release is today's base with `oldBaseSuffix` appended to every dynamic file; the
   * user's head is that old base with `edited` on top. The agent gets `migration: { oldBase, edited }`.
   */
  migration?: { oldBaseSuffix: string; edited: FileRefMap }
  expected: {
    verdict: AgentVerdict
    /** The task requires a change to the dynamic files (verdicts ok and partial). */
    change: boolean
  }
  invariants?: TaskInvariants
  /** A correct answer: must pass every grader (`pnpm eval:sanity`). Omit for tasks whose answer is no change. */
  reference?: { files: FileRefMap; deleted?: string[] }
  /** USD cap for this task (default 0.5). */
  budgetUsd?: number
  /** How the offline recording is produced: the scripted fixture (by `name`) that plays the agent. */
  record?: { fixture: string }
  tags?: string[]
}

export type GraderName = 'verdict' | 'change' | 'check' | 'typecheck' | 'invariants' | 'predicates' | 'budget' | 'browser'

export interface GraderResult {
  grader: GraderName
  pass: boolean
  /** Not applicable or switched off (counts as a pass, shown grey in the report). */
  skipped?: boolean
  reason: string
}

/** Who answered: a replayed transcript, the reference solution, the null agent, a scripted fixture, a live model. */
export type AgentKind = 'replay' | 'reference' | 'null' | 'scripted' | 'live'

export interface Tokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface TaskRun {
  taskId: string
  /** The task's app (absent in results written before the foreign apps: the demo). */
  app?: AppId
  /** 1, 2, … when a task runs several times (`--trials`, or several transcripts of a set). */
  trial?: number
  title: string
  agent: AgentKind
  expectedVerdict: AgentVerdict
  verdict: AgentVerdict | null
  summary: string
  /** The administrator's note of a partial or needs-backend answer. */
  backendNote?: string
  changedFiles: string[]
  modelCalls: number
  /** null: no files were written; true: no failed check or finish on the way. */
  firstTry: boolean | null
  costUsd: number
  /** Usage rows whose model has no price (scripted, replay of scripted): their cost is unknown, not 0. */
  unpricedModels: string[]
  tokens: Tokens
  /** The main model of the run (a replay: the recorded one). */
  model?: string
  /** Usage by model as the agent reports it (classifier and main loop), for `cacheHitRate()`. */
  usage?: UsageByModel[]
  ms: number
  /** The agent's own timings (classifier, model, tools, and the parallel overlap, DECISIONS 73.3). */
  timings?: AgentResult['timings']
  stopReason?: AgentResult['stopReason']
  graders: GraderResult[]
  pass: boolean
  /** The runner stopped this task (per-task budget, error). */
  error?: string
  /** Transcript this run replayed or recorded, and the prompt version it was recorded with. */
  recording?: { file: string; promptVersion: string | null }
}

export interface PromptInfo {
  version: string
  /** Characters of the cached prefix (instructions + digests + readonly sources + core types) for the demo app. */
  prefixChars: number
  /** ≈ tokens: instructions at 2.9, the app's code at 2.2 characters per token, plus ≈ 900 for the tool definitions. */
  prefixTokens: number
  /** The same per app when the run spans several apps. */
  byApp?: Partial<Record<AppId, { prefixChars: number; prefixTokens: number }>>
}

export interface SuiteResult {
  kind: 'replay' | 'sanity-reference' | 'sanity-null' | 'record' | 'live'
  startedAt: string
  finishedAt: string
  prompt: PromptInfo
  budget: { capUsd: number | null; spentUsd: number }
  /** The run was stopped by the global budget (PLEATKIT_EVAL_BUDGET_USD) before these tasks. */
  aborted?: { reason: string; notRun: string[] }
  browser: 'ran' | 'skipped'
  typecheck: 'ran' | 'skipped'
  /** Named set of transcripts (`--set live`): `evals/recordings/<set>/`. Absent: the scripted transcripts. */
  set?: string
  /** The main model of a live run, and whether the classifier ran first (`--no-classifier`). */
  model?: string
  classifier?: boolean
  /** The classifier waited for (absent: parallel, the default since DECISIONS 73.3). */
  classifierMode?: 'sequential'
  runs: TaskRun[]
}

/**
 * The pinned results new runs are compared with: `evals/baseline.json` (the live series), `evals/baseline.scripted.json`
 * (the scripted transcripts). With several trials a task's entry sums them: `passes` of `trials`, cost of all trials.
 */
export interface Baseline {
  pinnedAt: string
  promptVersion: string
  prompt: PromptInfo
  tasks: Record<string, { pass: boolean; verdict: AgentVerdict | null; failed: string[]; costUsd: number; modelCalls: number; passes?: number; trials?: number }>
  passRate: number
}
