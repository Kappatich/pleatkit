import type { PleatkitManifest, RequestClass } from '@pleatkit/runtime/compiler'
import type { PromptTokenCount } from './prefix.js'
import type { JevAnswer, JevRoute } from './providers/typesafe.js'
import type { BackendQuote, Classification, ClassifyInput, ModelProvider, ModelSession, PromptParts, ToolSpec } from './types.js'
import type { ClusterInput, ClusterOutput } from './wishes.js'

/**
 * DECISIONS 83, block 6: the classifier ensemble (PLEATKIT_CLASSIFIER_ENSEMBLE=jev). Jev (TypeSafe, ~0.3 s) and the
 * classifier model (Haiku, ~1.3 s) start together, with the main model's early call as before. Jev decides alone when:
 *
 * - its route is one Jev was reliable on in the probe: `ui`, `partial` (a mixed request: the main model does the screen
 *   part and passes the rest on, as for Haiku's "ui"), `needs-backend` or `restore`;
 * - its confidence is at least 0.9;
 * - its own adversarial check (a yes/no probability) is below 0.2;
 * - and the classifier model, if it has already answered by then, did not mark the request adversarial (its answer is
 *   not waited for: "when it arrives within the Jev decision, else skip").
 *
 * Otherwise (a vague request, off-topic, declined, not-editable, low confidence, an error) the classifier model decides
 * exactly as without the ensemble. Jev writes no text, so a needs-backend decision still takes the user's sentence, the
 * gist and the verbatim backend quote from the classifier model: its own answer when it also said needs-backend, else a
 * follow-up call that asks only for them (`quoteBackend`). A `partial` route goes to the main model, whose finish writes
 * the quote, as for a mixed request today.
 */
export interface EnsembleRule {
  minConfidence: number
  maxAdversarial: number
  routes: readonly JevRoute[]
}

export const ENSEMBLE_RULE: EnsembleRule = { minConfidence: 0.9, maxAdversarial: 0.2, routes: ['ui', 'partial', 'needs-backend', 'restore'] }

/** The routes and the classifier's labels: Jev's `partial` is the model's "ui" (the main model does the screen part). */
export function labelOfRoute(route: JevRoute): RequestClass | null {
  return route === 'ui' || route === 'partial' ? 'ui' : route === 'needs-backend' ? 'needs-backend' : route === 'restore' ? 'restore' : null
}

/** Whether Jev's answer decides the route alone, given the classifier model's answer if it is already here. */
export function jevDecides(j: Pick<JevAnswer, 'route' | 'confidence' | 'adversarial'>, modelSoFar: Pick<Classification, 'intentLabel'> | null, rule: EnsembleRule = ENSEMBLE_RULE): boolean {
  if (!j.route || !rule.routes.includes(j.route) || labelOfRoute(j.route) === null) return false
  if (j.confidence < rule.minConfidence) return false
  // a missing adversarial answer is not a clean one
  if (j.adversarial === null || j.adversarial >= rule.maxAdversarial) return false
  if (modelSoFar?.intentLabel === 'adversarial') return false
  return true
}

/** The part of Jev's answer kept with the result (AgentResult.classifier). */
const jevInfo = (j: JevAnswer | null) => (j ? { route: j.route ?? 'none', confidence: j.confidence, adversarial: j.adversarial, ms: j.ms } : null)

export interface JevRouter {
  route(input: ClassifyInput, signal: AbortSignal): Promise<JevAnswer>
}

export interface EnsembleOptions {
  rule?: Partial<EnsembleRule>
  log?: (line: string) => void
  /**
   * How long Jev may still take after the classifier model has answered (default 150 ms). A slow or hanging TypeSafe
   * then costs at most this much on top of the model alone; Jev's late answer is dropped (its usage still metered).
   */
  graceMs?: number
}

/** Jev's answer did not come within the grace after the classifier model's. */
const LATE = Symbol('late')

/**
 * A provider whose `classify` is the ensemble; everything else is the inner provider's. Wraps the configured model
 * provider (config.ts), so the agent server, the evals and `eval:classify` get it the same way.
 */
export class EnsembleProvider implements ModelProvider {
  readonly name: string
  readonly model: string
  readonly rule: EnsembleRule
  private readonly log: (line: string) => void
  private readonly graceMs: number

  constructor(
    readonly inner: ModelProvider,
    private readonly jev: JevRouter,
    options: EnsembleOptions = {},
  ) {
    this.name = inner.name
    this.model = inner.model
    this.rule = { ...ENSEMBLE_RULE, ...options.rule }
    this.log = options.log ?? (() => undefined)
    this.graceMs = options.graceMs ?? 150
  }

  get clusterModel(): string | undefined {
    return this.inner.clusterModel
  }

  cluster(input: ClusterInput, signal: AbortSignal): Promise<ClusterOutput> {
    return this.inner.cluster ? this.inner.cluster(input, signal) : Promise.resolve({ clusters: [], usage: null, model: null })
  }

  countPromptTokens(manifest: PleatkitManifest): Promise<PromptTokenCount> {
    if (!this.inner.countPromptTokens) return Promise.reject(new Error('the provider cannot count tokens'))
    return this.inner.countPromptTokens(manifest)
  }

  quoteBackend(input: ClassifyInput, signal: AbortSignal): Promise<BackendQuote> {
    if (!this.inner.quoteBackend) return Promise.reject(new Error('the provider cannot quote'))
    return this.inner.quoteBackend(input, signal)
  }

  start(prompt: PromptParts, tools: ToolSpec[], meta: { request: string }): ModelSession {
    return this.inner.start(prompt, tools, meta)
  }

  async classify(input: ClassifyInput, signal: AbortSignal): Promise<Classification> {
    let modelSoFar: Classification | null = null
    const { onLate, ...rest } = input
    const viaModel = this.inner.classify(rest, signal).then((c) => {
      modelSoFar = c
      return c
    })
    viaModel.catch(() => undefined)

    let j: JevAnswer | null = null
    const viaJev = this.jev.route(rest, signal)
    viaJev.catch(() => undefined)
    // the classifier model answered first: Jev gets `graceMs` more, then the model decides alone
    const modelThenGrace = viaModel.then(
      () => new Promise<typeof LATE>((r) => setTimeout(() => r(LATE), this.graceMs)),
      () => new Promise<never>(() => undefined),
    )
    try {
      const first = await Promise.race([viaJev, modelThenGrace])
      if (first === LATE) {
        this.log('[pleatkit-agent] classifier ensemble: Jev answered after the classifier model; the model decides')
        // a late answer is still billed: its usage goes to the run if it arrives while the run is going
        viaJev.then((late) => onLate?.({ label: 'ui', reason: '', usage: late.usage, model: late.model }), () => undefined)
      } else j = first
    } catch (e) {
      if (signal.aborted) throw e
      this.log(`[pleatkit-agent] classifier ensemble: Jev did not answer (${(e as Error).message}); the classifier model decides`)
    }
    const extra = j ? [{ model: j.model, usage: j.usage }] : []
    const ensemble = (decidedBy: 'jev' | 'model') => ({ decidedBy, jev: jevInfo(j) })

    if (j && j.route && jevDecides(j, modelSoFar as Classification | null, this.rule)) {
      const label = labelOfRoute(j.route)!
      if (label === 'needs-backend') {
        // Jev writes no text: the sentence for the user, the gist and the quote come from the classifier model
        const m = await viaModel.catch(() => null)
        if (m && m.label === 'needs-backend') return { ...m, extraUsage: [...extra, ...(m.extraUsage ?? [])], ensemble: ensemble('jev') }
        const q = this.inner.quoteBackend ? await this.inner.quoteBackend(rest, signal).catch(() => null) : null
        const more = [...(m?.usage && m.model ? [{ model: m.model, usage: m.usage }] : []), ...(q?.usage && q.model ? [{ model: q.model, usage: q.usage }] : [])]
        return {
          label,
          reason: q?.reason ?? '',
          ...(q?.backendQuote ? { backendQuote: q.backendQuote } : {}),
          ...((q?.intentLabel ?? m?.intentLabel) ? { intentLabel: q?.intentLabel ?? m?.intentLabel } : {}),
          ...((q?.gist ?? m?.gist) ? { gist: q?.gist ?? m?.gist } : {}),
          usage: null,
          model: null,
          extraUsage: [...extra, ...more],
          ensemble: ensemble('jev'),
        }
      }
      const now = modelSoFar as Classification | null
      if (now) {
        // the classifier model was faster this time: its usage and intent label come with the answer
        return { label, reason: '', ...(now.intentLabel ? { intentLabel: now.intentLabel } : {}), ...(now.gist ? { gist: now.gist } : {}), usage: now.usage, model: now.model, extraUsage: [...extra, ...(now.extraUsage ?? [])], ensemble: ensemble('jev') }
      }
      // the classifier model finishes later: its usage and intent label go to the run through onLate
      viaModel.then((m) => onLate?.(m), () => undefined)
      const result: Classification = { label, reason: '', usage: null, model: null, extraUsage: extra, ensemble: ensemble('jev') }
      // for measurements (eval:classify): settles when the classifier model's call has ended; not serialized
      Object.defineProperty(result, 'settled', { value: viaModel.then((m) => m, () => null), enumerable: false })
      return result
    }

    const m = await viaModel
    return { ...m, extraUsage: [...extra, ...(m.extraUsage ?? [])], ensemble: ensemble('model') }
  }
}

/** The classifier model's late answer of a classification Jev decided alone (eval:classify waits for it). */
export function settledOf(c: Classification): Promise<Classification | null> | null {
  const s = (c as unknown as { settled?: Promise<Classification | null> }).settled
  return s ?? null
}
