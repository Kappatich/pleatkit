import { AnthropicProvider } from './providers/anthropic.js'
import { OpenAICompatibleProvider } from './providers/openai.js'
import { ScriptedProvider } from './providers/scripted.js'
import { agentAuthFromEnv, type AgentAuth } from './auth.js'
import type { AgentLimits } from './loop.js'
import { alertsFromEnv, type AlertsOptions } from './alerts.js'
import { manifestSourceFromEnv, type ManifestSource } from './manifest.js'
import { typecheckFromEnv } from './typecheck.js'
import type { TypecheckFn } from './workspace.js'
import type { ModelProvider } from './types.js'

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
  /** MORPHKIT_TYPECHECK=1: type errors against the app's `.d.ts` refuse an edit (05 #4). */
  typecheck: TypecheckFn | null
  /** MORPHKIT_ALERT_* and MORPHKIT_FREEZE (05 #5). */
  alerts: Pick<AlertsOptions, 'sinks' | 'freeze'>
}

type Env = Record<string, string | undefined>

const num = (v: string | undefined): number | undefined => (v && Number.isFinite(Number(v)) ? Number(v) : undefined)

/**
 * Configuration from environment variables only: keys never come from the browser or from files in the repo.
 *
 * MORPHKIT_PROVIDER    anthropic | openai-compatible | scripted (default: anthropic when MORPHKIT_API_KEY is set, else scripted)
 * MORPHKIT_API_KEY     model API key (anthropic also accepts POLYMORPH_API_KEY / ANTHROPIC_API_KEY when MORPHKIT_PROVIDER=anthropic)
 * MORPHKIT_MODEL       main model (default claude-sonnet-5-5)
 * MORPHKIT_CLASSIFIER_MODEL  classifier (default claude-haiku-5-5)
 * MORPHKIT_BASE_URL    API base URL (required for openai-compatible, e.g. https://openrouter.ai/api/v1)
 * MORPHKIT_EFFORT      low | medium | high | xhigh | max (anthropic, default medium)
 * MORPHKIT_FALLBACKS   off disables Anthropic server-side refusal fallback
 * MORPHKIT_FIXTURES    directory of scripted fixtures (*.json)
 * MORPHKIT_SCRIPTED_DELAY_MS  pause before each scripted answer (recorded demos), default 0
 * MORPHKIT_STORE_URL   @morphkit/store-server URL for the request log
 * MORPHKIT_AGENT_PORT  default 8789
 * MORPHKIT_MAX_CALLS, MORPHKIT_TIMEOUT_MS, MORPHKIT_MAX_OUTPUT_TOKENS  limits (12, 90000, 8000 visible output tokens)
 * MORPHKIT_CORS_ORIGIN allowed browser origin, if the app calls the agent cross-origin
 * MORPHKIT_APP_ID, MORPHKIT_APP_KEY, MORPHKIT_JWT_SECRET  credentials; required with NODE_ENV=production
 * MORPHKIT_PLAN        plan name (free | team | unlimited) when store-server has no plan for the app
 * MORPHKIT_LIMITS      JSON overrides of plan limits, e.g. {"userDailyUsd": 2, "perEditUsd": 0.2}
 * MORPHKIT_TYPECHECK=1  type-check edits against the manifest's readonly sources and .d.ts; MORPHKIT_TYPECHECK_ROOT
 *                      is the app folder whose node_modules give package types (react)
 * MORPHKIT_ALERT_WEBHOOK  URL that gets a JSON POST for every alert (Slack-compatible `text`)
 * MORPHKIT_ALERT_EMAIL_URL, MORPHKIT_ALERT_EMAIL_TO, MORPHKIT_ALERT_EMAIL_TOKEN  e-mail through an HTTP e-mail API
 * MORPHKIT_FREEZE      off, or JSON {"violationsPerHour": 3, "requestsPerMinute": 12, "userShareOfAppBudget": 0.3}
 * MORPHKIT_MANIFEST    path or URL of the app's dist/morphkit.manifest.json: the static rules, readonly sources and core
 *                      types come from it, not from the browser (required with NODE_ENV=production);
 *                      MORPHKIT_MANIFESTS='{"<appId>": "<path or URL>"}' for several apps
 */
export function configFromEnv(env: Env = process.env): AgentConfig {
  const explicit = env.MORPHKIT_PROVIDER
  const kind = explicit ?? (env.MORPHKIT_API_KEY ? 'anthropic' : 'scripted')
  let provider: ModelProvider
  if (kind === 'anthropic') {
    const apiKey = env.MORPHKIT_API_KEY ?? env.POLYMORPH_API_KEY ?? env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('MORPHKIT_PROVIDER=anthropic needs MORPHKIT_API_KEY (or ANTHROPIC_API_KEY)')
    provider = new AnthropicProvider({
      apiKey,
      baseURL: env.MORPHKIT_BASE_URL,
      model: env.MORPHKIT_MODEL,
      classifierModel: env.MORPHKIT_CLASSIFIER_MODEL,
      effort: (env.MORPHKIT_EFFORT as 'medium' | undefined) ?? 'medium',
      fallbacks: env.MORPHKIT_FALLBACKS !== 'off',
    })
  } else if (kind === 'openai-compatible' || kind === 'openai' || kind === 'openrouter') {
    const apiKey = env.MORPHKIT_API_KEY ?? env.OPENAI_API_KEY ?? env.OPENROUTER_API_KEY
    if (!apiKey) throw new Error('MORPHKIT_PROVIDER=openai-compatible needs MORPHKIT_API_KEY')
    const baseURL = env.MORPHKIT_BASE_URL ?? (kind === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1')
    if (!env.MORPHKIT_MODEL) throw new Error('MORPHKIT_PROVIDER=openai-compatible needs MORPHKIT_MODEL')
    provider = new OpenAICompatibleProvider({ apiKey, baseURL, model: env.MORPHKIT_MODEL, classifierModel: env.MORPHKIT_CLASSIFIER_MODEL })
  } else if (kind === 'scripted') {
    provider = new ScriptedProvider(env.MORPHKIT_FIXTURES ?? 'fixtures', { delayMs: num(env.MORPHKIT_SCRIPTED_DELAY_MS) ?? 0 })
  } else {
    throw new Error(`Unknown MORPHKIT_PROVIDER "${kind}"`)
  }
  let planLimits: Record<string, number> | undefined
  if (env.MORPHKIT_LIMITS) {
    try {
      planLimits = JSON.parse(env.MORPHKIT_LIMITS) as Record<string, number>
    } catch {
      throw new Error('MORPHKIT_LIMITS must be JSON, e.g. {"userDailyUsd": 2}')
    }
  }
  const auth = agentAuthFromEnv(env)
  const manifest = manifestSourceFromEnv(env)
  if (auth.production && !manifest) {
    throw new Error('NODE_ENV=production: refusing to start without MORPHKIT_MANIFEST (the path or URL of the app build\'s morphkit.manifest.json); the browser must not decide what the static rules allow')
  }
  return {
    auth,
    manifest,
    typecheck: typecheckFromEnv(env),
    alerts: alertsFromEnv(env),
    plan: { ...(env.MORPHKIT_PLAN ? { name: env.MORPHKIT_PLAN } : {}), ...(planLimits ? { limits: planLimits } : {}) },
    provider,
    port: num(env.MORPHKIT_AGENT_PORT) ?? 8789,
    storeUrl: env.MORPHKIT_STORE_URL || null,
    corsOrigin: env.MORPHKIT_CORS_ORIGIN || null,
    limits: {
      ...(num(env.MORPHKIT_MAX_CALLS) ? { maxModelCalls: num(env.MORPHKIT_MAX_CALLS) } : {}),
      ...(num(env.MORPHKIT_TIMEOUT_MS) ? { timeoutMs: num(env.MORPHKIT_TIMEOUT_MS) } : {}),
      ...(num(env.MORPHKIT_MAX_OUTPUT_TOKENS) ? { maxOutputTokens: num(env.MORPHKIT_MAX_OUTPUT_TOKENS) } : {}),
    },
  }
}
