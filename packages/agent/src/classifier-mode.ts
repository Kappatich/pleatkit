import type { AgentResult } from '@pleatkit/runtime/compiler'

/**
 * DECISIONS 75 Р5 / 76.3: the automatic choice between the parallel and the sequential classifier, per app.
 *
 * In parallel mode the main model's first call starts together with the classifier and is cancelled when the
 * classifier answers alone (needs-backend, a clarifying question, off-topic, declined). That saves ~1.3 s on an edit
 * and costs the cancelled call ($0.02–0.03 on the foreign apps) on every request the classifier answers alone. So an
 * app whose requests the classifier mostly answers alone runs sequential.
 *
 * The rule: over the last 7 days (hourly buckets, so memory is bounded), the share of requests the classifier
 * answered alone among the requests it ran on. Fewer than `minSample` classified requests: parallel (the default).
 * Otherwise parallel switches to sequential when the share is above `enterSequential` (50 %) and comes back when it
 * is at or below `leaveSequential` (45 %). The band: at the minimum sample one request moves the share by 5 points,
 * so without it an app near 50 % would flip on almost every request; the share itself does not depend on the mode
 * (the classifier answers the same either way), so the band is only against that noise.
 */
export type ClassifierMode = 'parallel' | 'sequential'
/** PLEATKIT_CLASSIFIER: `auto` (default) picks per app; `parallel` and `sequential` fix the mode for every app. */
export type ClassifierSetting = 'auto' | ClassifierMode

export interface AutoClassifierRule {
  windowMs: number
  bucketMs: number
  /** Classified requests in the window before the mode can leave parallel. */
  minSample: number
  /** Switch to sequential when the share answered alone is above this. */
  enterSequential: number
  /** Back to parallel when it is at or below this. */
  leaveSequential: number
}

export const AUTO_CLASSIFIER_RULE: AutoClassifierRule = {
  windowMs: 7 * 24 * 60 * 60 * 1000,
  bucketMs: 60 * 60 * 1000,
  minSample: 20,
  enterSequential: 0.5,
  leaveSequential: 0.45,
}

/** Verdicts the classifier gives on its own (loop.ts, the `cancelEarly()` paths). */
export const CLASSIFIER_ONLY_VERDICTS: readonly AgentResult['verdict'][] = ['needs-backend', 'clarify', 'refused', 'declined', 'restore']

/** The classifier ran on this request (not a pointed-at panel, a clarification answer, a migration or a refusal before the run). */
export function classifierRan(r: Pick<AgentResult, 'timings'>): boolean {
  return r.timings.classifyMs !== null && r.timings.classifyMs !== undefined
}

/**
 * The classifier answered alone: it ran, the main model was not used (no model call, no tool call) and the verdict is
 * one the classifier gives. store-server's GET /v1/classifier-stats counts the same from the request log (classifyMs
 * in `timings`, the verdict, an empty tool log), so history from before this process agrees with what it counts.
 */
export function answeredByClassifierAlone(r: Pick<AgentResult, 'timings' | 'verdict' | 'log'> & Partial<Pick<AgentResult, 'modelCalls'>>): boolean {
  return classifierRan(r) && (r.modelCalls ?? 0) === 0 && r.log.length === 0 && CLASSIFIER_ONLY_VERDICTS.includes(r.verdict)
}

/** The mode for `classified` requests of which `alone` the classifier answered alone, given the current mode. */
export function decideClassifierMode(current: ClassifierMode, classified: number, alone: number, rule: AutoClassifierRule = AUTO_CLASSIFIER_RULE): ClassifierMode {
  if (classified < rule.minSample || classified <= 0) return 'parallel'
  const share = alone / classified
  if (current === 'sequential') return share > rule.leaveSequential ? 'sequential' : 'parallel'
  return share > rule.enterSequential ? 'sequential' : 'parallel'
}

export interface ClassifierBucket {
  /** Start of the bucket (ms since the epoch, a multiple of the bucket size). */
  hourMs: number
  classified: number
  alone: number
}

/** History of an app from before this process: store-server's request log (`StoreClient.classifierStats`). */
export type ClassifierSeed = (appId: string, sinceMs: number) => Promise<ClassifierBucket[]>

export interface AppClassifierStats {
  mode: ClassifierMode
  /** Classified requests in the window and how many of them the classifier answered alone. */
  classified: number
  alone: number
  share: number | null
  /** The history came from store-server (false: this process only, or the store did not answer). */
  seeded: boolean
}

interface AppState {
  buckets: ClassifierBucket[]
  mode: ClassifierMode
  seeded: boolean
  ready: Promise<void> | null
}

export interface ClassifierModesOptions {
  seed?: ClassifierSeed | null
  rule?: Partial<AutoClassifierRule>
  now?: () => number
  log?: (line: string) => void
  /** Apps kept in memory (least recently used dropped first). Default 1000. */
  maxApps?: number
}

/** Per-app history in this process and the mode it gives (PLEATKIT_CLASSIFIER=auto). */
export class ClassifierModes {
  readonly rule: AutoClassifierRule
  private readonly apps = new Map<string, AppState>()
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly maxApps: number

  constructor(private readonly options: ClassifierModesOptions = {}) {
    this.rule = { ...AUTO_CLASSIFIER_RULE, ...options.rule }
    this.now = options.now ?? Date.now
    this.log = options.log ?? (() => undefined)
    this.maxApps = Math.max(1, options.maxApps ?? 1000)
  }

  /** The mode for the app's next request; the first call per app waits for the store's history. */
  async modeFor(appId: string): Promise<ClassifierMode> {
    const st = this.state(appId)
    if (st.ready) await st.ready
    return this.update(appId, st)
  }

  /** Count a finished run (runs the classifier did not run on are not counted). */
  record(appId: string, result: Pick<AgentResult, 'timings' | 'verdict' | 'log'> & Partial<Pick<AgentResult, 'modelCalls'>>): void {
    if (!classifierRan(result)) return
    const st = this.state(appId)
    this.add(st, { hourMs: this.bucketOf(this.now()), classified: 1, alone: answeredByClassifierAlone(result) ? 1 : 0 })
    this.update(appId, st)
  }

  stats(appId: string): AppClassifierStats {
    const st = this.apps.get(appId)
    if (!st) return { mode: 'parallel', classified: 0, alone: 0, share: null, seeded: false }
    this.prune(st)
    const { classified, alone } = this.sum(st)
    return { mode: st.mode, classified, alone, share: classified ? alone / classified : null, seeded: st.seeded }
  }

  /** Every app this process knows, for /agent/v1/health. */
  snapshot(): Record<string, AppClassifierStats> {
    return Object.fromEntries([...this.apps.keys()].map((id) => [id, this.stats(id)]))
  }

  private state(appId: string): AppState {
    let st = this.apps.get(appId)
    if (st) {
      // least recently used last out
      this.apps.delete(appId)
      this.apps.set(appId, st)
      return st
    }
    st = { buckets: [], mode: 'parallel', seeded: false, ready: null }
    this.apps.set(appId, st)
    if (this.apps.size > this.maxApps) this.apps.delete(this.apps.keys().next().value!)
    const seed = this.options.seed
    if (seed) {
      const s = st
      s.ready = seed(appId, this.now() - this.rule.windowMs)
        .then((buckets) => {
          for (const b of buckets) {
            if (Number.isFinite(b.hourMs) && b.classified > 0) this.add(s, { hourMs: this.bucketOf(b.hourMs), classified: b.classified, alone: Math.min(b.alone, b.classified) })
          }
          s.seeded = true
        })
        .catch((e: Error) => this.log(`[pleatkit-agent] ${appId}: no classifier history from store-server (${e.message}); counting from now`))
        .finally(() => void (s.ready = null))
    }
    return st
  }

  private bucketOf(ms: number): number {
    return Math.floor(ms / this.rule.bucketMs) * this.rule.bucketMs
  }

  private add(st: AppState, b: ClassifierBucket): void {
    const same = st.buckets.find((x) => x.hourMs === b.hourMs)
    if (same) {
      same.classified += b.classified
      same.alone += b.alone
      return
    }
    st.buckets.push({ ...b })
    st.buckets.sort((x, y) => x.hourMs - y.hourMs)
  }

  /** Drop buckets that ended before the window (at most windowMs / bucketMs + 1 stay). */
  private prune(st: AppState): void {
    const from = this.now() - this.rule.windowMs
    while (st.buckets.length && st.buckets[0]!.hourMs + this.rule.bucketMs <= from) st.buckets.shift()
  }

  private sum(st: AppState): { classified: number; alone: number } {
    return st.buckets.reduce((s, b) => ({ classified: s.classified + b.classified, alone: s.alone + b.alone }), { classified: 0, alone: 0 })
  }

  private update(appId: string, st: AppState): ClassifierMode {
    this.prune(st)
    const { classified, alone } = this.sum(st)
    const mode = decideClassifierMode(st.mode, classified, alone, this.rule)
    if (mode !== st.mode) {
      const pct = classified ? Math.round((alone / classified) * 100) : 0
      this.log(`[pleatkit-agent] ${appId}: classifier ${st.mode} -> ${mode} (${alone} of ${classified} classified requests in ${Math.round(this.rule.windowMs / 86_400_000)} days answered by the classifier alone, ${pct} %)`)
      st.mode = mode
    }
    return mode
  }
}
