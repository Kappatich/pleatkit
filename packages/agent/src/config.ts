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
import { pleatkitEnv } from '@pleatkit/runtime/env'

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
  /** PLEATKIT_TYPECHECK=1: type errors against the app's `.d.ts` refuse an edit (05 #4). */
  typecheck: TypecheckFn | null
  /** PLEATKIT_ALERT_* and PLEATKIT_FREEZE (05 #5). */
  alerts: Pick<AlertsOptions, 'sinks' | 'freeze'>
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
 * PLEATKIT_FIXTURES    directory of scripted fixtures (*.json)
 * PLEATKIT_SCRIPTED_DELAY_MS  pause before each scripted answer (recorded demos), default 0
 * PLEATKIT_STORE_URL   @pleatkit/store-server URL for the request log
 * PLEATKIT_AGENT_PORT  default 8789
 * PLEATKIT_MAX_CALLS, PLEATKIT_TIMEOUT_MS, PLEATKIT_MAX_OUTPUT_TOKENS  limits (12, 90000, 8000 visible output tokens)
 * PLEATKIT_CORS_ORIGIN allowed browser origin, if the app calls the agent cross-origin
 * PLEATKIT_APP_ID, PLEATKIT_APP_KEY, PLEATKIT_JWT_SECRET  credentials; required with NODE_ENV=production
 * PLEATKIT_PLAN        plan name (free | team | unlimited) when store-server has no plan for the app
 * PLEATKIT_LIMITS      JSON overrides of plan limits, e.g. {"userDailyUsd": 2, "perEditUsd": 0.2}
 * PLEATKIT_TYPECHECK=1  type-check edits against the manifest's readonly sources and .d.ts; PLEATKIT_TYPECHECK_ROOT
 *                      is the app folder whose node_modules give package types (react)
 * PLEATKIT_ALERT_WEBHOOK  URL that gets a JSON POST for every alert (Slack-compatible `text`)
 * PLEATKIT_ALERT_EMAIL_URL, PLEATKIT_ALERT_EMAIL_TO, PLEATKIT_ALERT_EMAIL_TOKEN  e-mail through an HTTP e-mail API
 * PLEATKIT_FREEZE      off, or JSON {"violationsPerHour": 3, "requestsPerMinute": 12, "userShareOfAppBudget": 0.3}
 * PLEATKIT_MANIFEST    path or URL of the app's dist/pleatkit.manifest.json: the static rules, readonly sources and core
 *                      types come from it, not from the browser (required with NODE_ENV=production);
 *                      PLEATKIT_MANIFESTS='{"<appId>": "<path or URL>"}' for several apps
 */
export function configFromEnv(env: Env = process.env): AgentConfig {
  pleatkitEnv(env)
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
  return {
    auth,
    manifest,
    typecheck: typecheckFromEnv(env),
    alerts: alertsFromEnv(env),
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

/**
 * The model provider alone (PLEATKIT_PROVIDER, PLEATKIT_API_KEY, PLEATKIT_MODEL, PLEATKIT_CLASSIFIER_MODEL,
 * PLEATKIT_FIXTURES...): what `pleatkit digest` and `pleatkit carry-over` need, without the server's settings.
 */
export function providerFromEnv(env: Env = process.env): ModelProvider {
  pleatkitEnv(env)
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
