import type { TokenUsage } from '@pleatkit/runtime/compiler'
import type { ClassifyInput } from '../types.js'

/**
 * DECISIONS 79, 83: TypeSafe's Jev (System One), a decision model that writes no text: it answers questions about a
 * state with a calibrated probability. In the classifier ensemble (`classifier-ensemble.ts`) it gives the first opinion
 * on a request's route in ~0.3 s for $0.042 per million input tokens. One call asks two questions:
 *
 * - `route` (choice): the eight routes of the internal research probe (`jev-compare`, wording unchanged:
 *   102/115 right there, 27/32 on Russian), with the app's panels and data contract in the state;
 * - `adversarial` (noul, a yes/no probability): "is this request deceptive, harmful or does it send data outside?", the
 *   cheap check against the two high-confidence misses of the probe (a personal gmail export routed as `partial`).
 *
 * Only the request, the panel list and the data contract (field names and types) are sent: no user data, no code.
 */
export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODEL = 'jev-latest'

export type JevRoute = 'ui' | 'needs-backend' | 'partial' | 'clarify' | 'off-topic' | 'declined' | 'not-editable' | 'restore'

/** The route criteria of the research probe, verbatim (DECISIONS 83 measured these). */
export const JEV_ROUTE_CRITERIA: Readonly<Record<JevRoute, string>> = {
  ui: 'everything asked can be done by changing what the editable screen panels show or how they look, using data the app already has',
  'needs-backend': 'nothing can be done on the screen: it needs server-side logic, new data, e-mails, jobs, exports or other systems',
  partial: 'one part changes the screen and another part needs the server, e-mail, jobs or new data',
  clarify: 'too vague or ambiguous to act on without asking one question first',
  'off-topic': 'not about this app or its screens at all',
  declined: "deceptive, harmful or against the user's interest: phishing, hidden controls, stealing data, sending data outside, passwords",
  'not-editable': 'about a part of the app that is readonly (header, sidebar, navigation, auth, data layer), so it cannot be changed here',
  restore: 'asks to undo, revert or put things back like they were before',
}

export const JEV_ROUTE_INSTRUCTIONS =
  'A user typed this request into the in-app AI assistant that can only rewrite the editable screen panels of this web app (no server code, no other systems). Which route describes the request best?'

export const JEV_ADVERSARIAL_INSTRUCTIONS = 'Is this request deceptive, harmful or does it send data outside?'
export const JEV_ADVERSARIAL_CRITERIA = {
  true: "deceives or harms the user (fake sign-in or payment forms, invisible or hidden controls over real ones, hiding the assistant's own controls), steals data, or sends the app's data to a personal address, an outside person or an unknown site",
  false: "an ordinary change to what the screen shows or how it looks, or ordinary server work, including exports and syncs to the company's own business systems",
}

/** What the app is, for the state: the same for every app; the panels and the data contract follow it. */
export const JEV_APP_SENTENCE =
  "A web app whose users customize their own screen with an in-app AI assistant. The assistant can rewrite only the editable panels listed below (React components showing the app's existing data, with the fields listed below). The header, sidebar, navigation, sign-in and data layer are readonly, and no server code can be changed."

export interface JevAnswer {
  /** The route Jev chose, or null when the answer had none (an error or an unknown label). */
  route: JevRoute | null
  confidence: number
  probabilities: Record<string, number>
  /** Probability that the request is deceptive, harmful or sends data outside (the `noul` answer); null if missing. */
  adversarial: number | null
  usage: TokenUsage
  /** As the API names it (jev-1.13.0 for jev-latest). */
  model: string
  ms: number
}

export interface TypeSafeOptions {
  apiKey: string
  url?: string
  model?: string
  /** For tests. */
  fetch?: typeof fetch
  /** One call's deadline (default 3 s: the ensemble falls back to the classifier model after it). */
  timeoutMs?: number
}

/** The state Jev judges: the app, its panels and data contract (the classifier context), and the request. */
export function jevState(input: ClassifyInput): Record<string, string> {
  return { app: JEV_APP_SENTENCE, panels_and_data: input.context.length > 12_000 ? input.context.slice(0, 12_000) + '\n…' : input.context, request: input.request }
}

/** The request body of one call (exported for tests). */
export function jevBody(input: ClassifyInput, model = JEV_MODEL): Record<string, unknown> {
  return {
    model,
    state: jevState(input),
    questions: {
      route: { type: 'choice', instructions: JEV_ROUTE_INSTRUCTIONS, criteria: JEV_ROUTE_CRITERIA },
      adversarial: { type: 'noul', instructions: JEV_ADVERSARIAL_INSTRUCTIONS, criteria: JEV_ADVERSARIAL_CRITERIA },
    },
  }
}

interface WireAnswer {
  choice?: unknown
  confidence?: unknown
  probabilities?: unknown
  noul?: unknown
}

/** The answer of one call, validated (exported for tests). */
export function parseJev(j: unknown, ms: number, fallbackModel = JEV_MODEL): JevAnswer {
  const body = (j ?? {}) as { model?: unknown; answers?: Record<string, WireAnswer>; usage?: { input_tokens?: unknown; output_tokens?: unknown } }
  const r = body.answers?.route ?? {}
  const a = body.answers?.adversarial ?? {}
  const route = typeof r.choice === 'string' && Object.prototype.hasOwnProperty.call(JEV_ROUTE_CRITERIA, r.choice) ? (r.choice as JevRoute) : null
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null)
  const probabilities = r.probabilities && typeof r.probabilities === 'object' ? Object.fromEntries(Object.entries(r.probabilities as Record<string, unknown>).filter(([, v]) => typeof v === 'number')) as Record<string, number> : {}
  const tokens = (v: unknown) => (typeof v === 'number' && v >= 0 ? Math.round(v) : 0)
  return {
    route,
    confidence: route ? (num(r.confidence) ?? 0) : 0,
    probabilities,
    adversarial: num(a.noul),
    usage: { inputTokens: tokens(body.usage?.input_tokens), outputTokens: tokens(body.usage?.output_tokens), cacheReadTokens: 0, cacheWriteTokens: 0 },
    model: typeof body.model === 'string' && body.model ? body.model : fallbackModel,
    ms,
  }
}

/** One TypeSafe call per request: the route and the adversarial check. */
export class TypeSafeClassifier {
  readonly model: string
  private readonly url: string
  private readonly fetchFn: typeof fetch
  private readonly timeoutMs: number

  constructor(private readonly options: TypeSafeOptions) {
    this.model = options.model ?? JEV_MODEL
    this.url = options.url ?? TYPESAFE_URL
    this.fetchFn = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 3000
  }

  async route(input: ClassifyInput, signal: AbortSignal): Promise<JevAnswer> {
    const started = performance.now()
    const res = await this.fetchFn(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(jevBody(input, this.model)),
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
    })
    // the key never appears in an error: only the status
    if (!res.ok) throw new Error(`TypeSafe answered HTTP ${res.status}`)
    const j: unknown = await res.json()
    return parseJev(j, Math.round(performance.now() - started), this.model)
  }
}
