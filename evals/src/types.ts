import type { AgentResult, AgentVerdict } from '@pleatkit/runtime/compiler'

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
  /** `data-testid` of the element. */
  testid: string
  /** `data-testid` of the panel to look in (default: the whole page). */
  within?: string
  /** Exact number of matching elements (0: must not exist). Default: at least one, the first is checked. */
  count?: number
  /** Exact text of the first match. */
  text?: string
  /** Substring of the text of the first match. */
  contains?: string
  /** Substring of the first match's class attribute. */
  class?: string
  /** An attribute of the first match and its exact value. */
  attr?: { name: string; value: string }
}

export interface BrowserInvariants {
  /** Customer selected in the list before the checks (a substring of the button's name). Default "Globex". */
  customer?: string
  checks: BrowserCheck[]
}

export interface TaskInvariants {
  files?: FileInvariant[]
  /** Regular expressions none of the changed files may match (forbidden patterns). */
  forbidden?: string[]
  /** Dynamic files the agent must not change. */
  unchanged?: string[]
  /** Names of custom predicates (`src/predicates.ts`). */
  predicates?: string[]
  browser?: BrowserInvariants
}

/** One eval task (`evals/tasks/*.json`). */
export interface EvalTask {
  id: string
  /** App the task runs against; only `demo-crm` for now. */
  app: 'demo-crm'
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
  title: string
  agent: AgentKind
  expectedVerdict: AgentVerdict
  verdict: AgentVerdict | null
  summary: string
  changedFiles: string[]
  modelCalls: number
  /** null: no files were written; true: no failed check or finish on the way. */
  firstTry: boolean | null
  costUsd: number
  /** Usage rows whose model has no price (scripted, replay of scripted): their cost is unknown, not 0. */
  unpricedModels: string[]
  tokens: Tokens
  ms: number
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
  /** ≈ tokens at 3.5 characters per token. */
  prefixTokens: number
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
  runs: TaskRun[]
}

/** `evals/baseline.json`: the pinned results new runs are compared with. */
export interface Baseline {
  pinnedAt: string
  promptVersion: string
  prompt: PromptInfo
  tasks: Record<string, { pass: boolean; verdict: AgentVerdict | null; failed: string[]; costUsd: number; modelCalls: number }>
  passRate: number
}
