import { AnthropicProvider } from './providers/anthropic.js'
import { OpenAICompatibleProvider } from './providers/openai.js'
import { ScriptedProvider } from './providers/scripted.js'
import { agentAuthFromEnv, type AgentAuth } from './auth.js'
import type { AgentLimits } from './loop.js'
import { alertsFromEnv, type AlertsOptions } from './alerts.js'
import { manifestSourceFromEnv, type ManifestSource } from './manifest.js'
import { DEFAULT_MODEL_CONCURRENCY, DEFAULT_RATE_LIMIT_RETRIES } from './rate-limit.js'
import { typecheckFromEnv } from './typecheck.js'
import type { TypecheckFn } from './workspace.js'
import type { ClassifierSetting } from './classifier-mode.js'
import type { ModelProvider } from './types.js'
import { wishLimitsFromEnv, type WishLimits } from './wishes.js'

export interface AgentConfig {
  provider: ModelProvider
  port: number
  storeUrl: string | null
  corsOrigin: string | null
  limits: Partial<AgentLimits>
  auth: AgentAuth
  /** Plan used when store-server has none for the app (V1 A4, F14). */
  plan: { name?: string; limits?: Record<string, number> }
  /** The app's manifest on the server (code review 06 item 8); required in production. */
  manifest: ManifestSource | null
  /**
   * The agent loop's type check (05 #4, DECISIONS 74.2): on by default when the app's packages are found next to the
   * manifest or in PLEATKIT_TYPECHECK_ROOT, PLEATKIT_TYPECHECK=0 turns it off (`typecheckFromEnv`).
   */
  typecheck: TypecheckFn | null
  /** Type check of server compiles (commits) too: only with an explicit PLEATKIT_TYPECHECK=1, as before. */
  commitTypecheck: TypecheckFn | null
  /** Stage 5 block 5: apps whose type check is warmed at start (every app with a manifest; PLEATKIT_TYPECHECK_WARM=0: none). */
  warmTypecheckApps: string[]
  /** PLEATKIT_CLASSIFIER: auto (default, per app from the week's history, DECISIONS 75 Р5), parallel or sequential (73.3). */
  classifierMode: ClassifierSetting
  /** PLEATKIT_ALERT_* and PLEATKIT_FREEZE (05 #5). */
  alerts: Pick<AlertsOptions, 'sinks' | 'freeze'>
  /** DECISIONS 70.3: PLEATKIT_WISHES_MAX_ITEMS (default 500) and PLEATKIT_WISHES_BUDGET_USD (default 0.50). */
  wishes: WishLimits
  /** Stage 5 block 3: PLEATKIT_MODEL_CONCURRENCY (default 8) model calls at a time in this process, the rest queue. */
  modelConcurrency: number
  /** PLEATKIT_RATE_LIMIT_RETRIES (default 3): retries of a model call refused with 429 / overloaded. */
  rateLimitRetries: number
}

type Env = Record<string, string | undefined>

const num = (v: string | undefined): number | undefined => (v && Number.isFinite(Number(v)) ? Number(v) : undefined)

/**
 * Configuration from environment variables only: keys never come from the browser or from files in the repo.
 *
 * PLEATKIT_PROVIDER    anthropic | openai-compatible | scripted (default: anthropic when PLEATKIT_API_KEY is set, else scripted)
 * PLEATKIT_API_KEY     model API key (anthropic also accepts POLYMORPH_API_KEY / ANTHROPIC_API_KEY when PLEATKIT_PROVIDER=anthropic)
 * PLEATKIT_MODEL       main model (default claude-sonnet-5-5)
 * PLEATKIT_CLASSIFIER_MODEL  classifier (default claude-haiku-5-5)
 * PLEATKIT_BASE_URL    API base URL (required for openai-compatible, e.g. https://openrouter.ai/api/v1)
 * PLEATKIT_EFFORT      low | medium | high | xhigh | max (anthropic, default medium)
 * PLEATKIT_FALLBACKS   off disables Anthropic server-side refusal fallback
 * PLEATKIT_STREAM      1: stream model calls with eager_input_streaming on the tools
 * PLEATKIT_CACHE_TAIL  after-first (default): the first call of an edit writes only the system prefix to the prompt
 *                      cache, so a one-call edit and a cancelled early call do not pay the 1.25x tail write
 *                      (DECISIONS 76.1); always: every call writes the tail, as before block 4
 * PLEATKIT_FIXTURES    directory of scripted fixtures (*.json)
 * PLEATKIT_SCRIPTED_DELAY_MS  pause before each scripted answer (recorded demos), default 0
 * PLEATKIT_STORE_URL   @pleatkit/store-server URL for the request log
 * PLEATKIT_AGENT_PORT  default 8789
 * PLEATKIT_MAX_CALLS, PLEATKIT_TIMEOUT_MS, PLEATKIT_MAX_OUTPUT_TOKENS  limits (12, 90000, 8000 visible output tokens)
 * PLEATKIT_CORS_ORIGIN allowed browser origin, if the app calls the agent cross-origin
 * PLEATKIT_APP_ID, PLEATKIT_APP_KEY, PLEATKIT_JWT_SECRET  credentials; required with NODE_ENV=production
 * PLEATKIT_PLAN        plan name (free | team | unlimited) when store-server has no plan for the app
 * PLEATKIT_LIMITS      JSON overrides of plan limits, e.g. {"userDailyUsd": 2, "perEditUsd": 0.2}
 * PLEATKIT_TYPECHECK   unset (auto): the agent loop type-checks edits against the manifest's readonly sources and .d.ts
 *                      when the app folder (PLEATKIT_TYPECHECK_ROOT, or the folder of the manifest's dist/) has
 *                      node_modules; 0: off; 1: always, also server compiles (packages are `any` without a root)
 * PLEATKIT_CLASSIFIER  auto (default): per app, sequential while the classifier answered more than 50 % of the app's
 *                      classified requests alone in the last 7 days (at least 20 of them; back to parallel at 45 %),
 *                      else parallel; history seeded from PLEATKIT_STORE_URL's request log. parallel: the classifier
 *                      and the main model start together, the main call is cancelled when the classifier answers
 *                      alone; sequential: the main model waits for the classifier
 * PLEATKIT_ALERT_WEBHOOK  URL that gets a JSON POST for every alert (Slack-compatible `text`)
 * PLEATKIT_ALERT_EMAIL_URL, PLEATKIT_ALERT_EMAIL_TO, PLEATKIT_ALERT_EMAIL_TOKEN  e-mail through an HTTP e-mail API
 * PLEATKIT_FREEZE      off, or JSON {"violationsPerHour": 3, "requestsPerMinute": 12, "userShareOfAppBudget": 0.3}
 * PLEATKIT_WISHES_MAX_ITEMS, PLEATKIT_WISHES_BUDGET_USD  the wish map's one call: at most 500 requests and $0.50 by default
 * PLEATKIT_MODEL_CONCURRENCY  model calls at a time in this process (default 8; the rest wait in a FIFO queue)
 * PLEATKIT_RATE_LIMIT_RETRIES  retries of a call refused with 429 / overloaded (default 3; retry-after, else 1, 2, 4 s)
 * PLEATKIT_MANIFEST    path or URL of the app's dist/pleatkit.manifest.json: the static rules, readonly sources and core
 *                      types come from it, not from the browser (required with NODE_ENV=production);
 *                      PLEATKIT_MANIFESTS='{"<appId>": "<path or URL>"}' for several apps
 */
export function configFromEnv(env: Env = process.env): AgentConfig {
  const provider = providerFromEnv(env)
  let planLimits: Record<string, number> | undefined
  if (env.PLEATKIT_LIMITS) {
    try {
      planLimits = JSON.parse(env.PLEATKIT_LIMITS) as Record<string, number>
    } catch {
      throw new Error('PLEATKIT_LIMITS must be JSON, e.g. {"userDailyUsd": 2}')
    }
  }
  const auth = agentAuthFromEnv(env)
  const manifest = manifestSourceFromEnv(env)
  if (auth.production && !manifest) {
    throw new Error('NODE_ENV=production: refusing to start without PLEATKIT_MANIFEST (the path or URL of the app build\'s pleatkit.manifest.json); the browser must not decide what the static rules allow')
  }
  const typecheck = typecheckFromEnv(env)
  const forced = ['1', 'true', 'on'].includes((env.PLEATKIT_TYPECHECK ?? '').trim().toLowerCase())
  // stage 5 block 5: warm the type check of every app with a manifest at start (PLEATKIT_TYPECHECK_WARM=0: off)
  const warm = typecheck && manifest && !['0', 'off', 'false'].includes((env.PLEATKIT_TYPECHECK_WARM ?? '').trim().toLowerCase())
  let warmApps: string[] = []
  if (warm) {
    let many: string[] = []
    try {
      many = env.PLEATKIT_MANIFESTS ? Object.keys(JSON.parse(env.PLEATKIT_MANIFESTS) as Record<string, string>) : []
    } catch {
      // manifestSourceFromEnv reports the bad JSON
    }
    warmApps = [...new Set([...(env.PLEATKIT_MANIFEST ? [env.PLEATKIT_APP_ID || 'default'] : []), ...many])]
  }
  return {
    auth,
    manifest,
    typecheck,
    warmTypecheckApps: warmApps,
    commitTypecheck: forced ? typecheck : null,
    classifierMode: classifierSettingFromEnv(env.PLEATKIT_CLASSIFIER),
    alerts: alertsFromEnv(env),
    wishes: wishLimitsFromEnv(env),
    modelConcurrency: Math.max(1, Math.floor(num(env.PLEATKIT_MODEL_CONCURRENCY) ?? DEFAULT_MODEL_CONCURRENCY)),
    rateLimitRetries: Math.max(0, Math.floor(num(env.PLEATKIT_RATE_LIMIT_RETRIES) ?? DEFAULT_RATE_LIMIT_RETRIES)),
    plan: { ...(env.PLEATKIT_PLAN ? { name: env.PLEATKIT_PLAN } : {}), ...(planLimits ? { limits: planLimits } : {}) },
    provider,
    port: num(env.PLEATKIT_AGENT_PORT) ?? 8789,
    storeUrl: env.PLEATKIT_STORE_URL || null,
    corsOrigin: env.PLEATKIT_CORS_ORIGIN || null,
    limits: {
      ...(num(env.PLEATKIT_MAX_CALLS) ? { maxModelCalls: num(env.PLEATKIT_MAX_CALLS) } : {}),
      ...(num(env.PLEATKIT_TIMEOUT_MS) ? { timeoutMs: num(env.PLEATKIT_TIMEOUT_MS) } : {}),
      ...(num(env.PLEATKIT_MAX_OUTPUT_TOKENS) ? { maxOutputTokens: num(env.PLEATKIT_MAX_OUTPUT_TOKENS) } : {}),
    },
  }
}

/** PLEATKIT_CLASSIFIER: auto (unset or empty), parallel or sequential; anything else is a configuration error. */
export function classifierSettingFromEnv(value: string | undefined): ClassifierSetting {
  const v = (value ?? '').trim().toLowerCase()
  if (v === '' || v === 'auto') return 'auto'
  if (v === 'parallel' || v === 'sequential') return v
  throw new Error(`PLEATKIT_CLASSIFIER must be auto, parallel or sequential (got "${value}")`)
}

/**
 * The model provider alone (PLEATKIT_PROVIDER, PLEATKIT_API_KEY, PLEATKIT_MODEL, PLEATKIT_CLASSIFIER_MODEL,
 * PLEATKIT_FIXTURES...): what `pleatkit digest` and `pleatkit carry-over` need, without the server's settings.
 */
export function providerFromEnv(env: Env = process.env): ModelProvider {
  const explicit = env.PLEATKIT_PROVIDER
  const kind = explicit ?? (env.PLEATKIT_API_KEY ? 'anthropic' : 'scripted')
  let provider: ModelProvider
  if (kind === 'anthropic') {
    const apiKey = env.PLEATKIT_API_KEY ?? env.POLYMORPH_API_KEY ?? env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('PLEATKIT_PROVIDER=anthropic needs PLEATKIT_API_KEY (or ANTHROPIC_API_KEY)')
    provider = new AnthropicProvider({
      apiKey,
      baseURL: env.PLEATKIT_BASE_URL,
      model: env.PLEATKIT_MODEL,
      classifierModel: env.PLEATKIT_CLASSIFIER_MODEL,
      effort: (env.PLEATKIT_EFFORT as 'medium' | undefined) ?? 'medium',
      fallbacks: env.PLEATKIT_FALLBACKS !== 'off',
      stream: env.PLEATKIT_STREAM === '1',
      ...(env.PLEATKIT_CACHE_TAIL === 'after-first' || env.PLEATKIT_CACHE_TAIL === 'always' ? { cacheTail: env.PLEATKIT_CACHE_TAIL } : {}),
    })
  } else if (kind === 'openai-compatible' || kind === 'openai' || kind === 'openrouter') {
    const apiKey = env.PLEATKIT_API_KEY ?? env.OPENAI_API_KEY ?? env.OPENROUTER_API_KEY
    if (!apiKey) throw new Error('PLEATKIT_PROVIDER=openai-compatible needs PLEATKIT_API_KEY')
    const baseURL = env.PLEATKIT_BASE_URL ?? (kind === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1')
    if (!env.PLEATKIT_MODEL) throw new Error('PLEATKIT_PROVIDER=openai-compatible needs PLEATKIT_MODEL')
    provider = new OpenAICompatibleProvider({ apiKey, baseURL, model: env.PLEATKIT_MODEL, classifierModel: env.PLEATKIT_CLASSIFIER_MODEL })
  } else if (kind === 'scripted') {
    provider = new ScriptedProvider(env.PLEATKIT_FIXTURES ?? 'fixtures', { delayMs: num(env.PLEATKIT_SCRIPTED_DELAY_MS) ?? 0 })
  } else {
    throw new Error(`Unknown PLEATKIT_PROVIDER "${kind}"`)
  }
  return provider
}
