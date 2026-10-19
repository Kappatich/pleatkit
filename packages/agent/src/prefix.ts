import Anthropic from '@anthropic-ai/sdk'
import type { AgentRunRequest, PleatkitManifest } from '@pleatkit/runtime/compiler'
import { trustedInput } from './manifest.js'
import { buildPrompt, digestsFromManifest, PROMPT_VERSION } from './prompt.js'
import { DEFAULT_MODEL } from './providers/anthropic.js'
import { TOOLS } from './tools.js'

/**
 * DECISIONS 73.5: the size of an app's prompt, counted by the API's token counter (`count_tokens`, free) instead of
 * estimated. The cached prefix is what every edit of this app re-reads (tools, instructions, digests, readonly
 * sources, core types); the tail is one request's own part (the dynamic files and a short request).
 */
export interface PromptTokenCount {
  /** Tokens of the cached prefix: the tools and the system blocks. */
  prefixTokens: number
  /** Tokens of the user message of a short request over the release's dynamic files. */
  tailTokens: number
  model: string
  promptVersion: string
}

export interface CountTokensOptions {
  apiKey?: string
  /** An SDK client to count with instead of `apiKey` (the agent server's own provider, DECISIONS 75 Р2). */
  client?: Anthropic
  baseURL?: string
  model?: string
  /** For tests: a fetch that never reaches the network. */
  fetch?: typeof fetch
}

/** The request the agent server would build for a short request on the release's files (as `trustedInput` does). */
export function sampleRequest(manifest: PleatkitManifest, request = 'Make the title bold.'): AgentRunRequest {
  const body: AgentRunRequest = {
    userId: 'doctor',
    appId: 'doctor',
    request,
    files: Object.fromEntries(manifest.dynamic.map((f) => [f.path, f.source])),
    readonly: {},
    coreTypes: {},
    context: { alias: manifest.alias, externals: manifest.externals, externalPatterns: manifest.externalPatterns, dynamicRoots: manifest.dynamicRoots },
    components: [],
  }
  const trusted = trustedInput(manifest, 'doctor', body)
  return { ...body, context: trusted.context, readonly: trusted.readonly, coreTypes: trusted.coreTypes, components: trusted.components }
}

export async function countPromptTokens(manifest: PleatkitManifest, o: CountTokensOptions): Promise<PromptTokenCount> {
  if (!o.client && !o.apiKey) throw new Error('countPromptTokens needs an API key or a client')
  const client = o.client ?? new Anthropic({ apiKey: o.apiKey, ...(o.baseURL ? { baseURL: o.baseURL } : {}), ...(o.fetch ? { fetch: o.fetch } : {}), maxRetries: 1 })
  const model = o.model ?? DEFAULT_MODEL
  const digests = digestsFromManifest(manifest)
  const parts = buildPrompt(sampleRequest(manifest), undefined, digests)
  const messages = [{ role: 'user' as const, content: parts.user }]
  // the same shape as AnthropicProvider sends: tools, then the two system blocks, then the request
  const full = await client.beta.messages.countTokens({
    model,
    system: [
      { type: 'text', text: parts.instructions },
      { type: 'text', text: parts.cached, cache_control: { type: 'ephemeral' } },
    ],
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Beta.BetaTool.InputSchema })),
    messages,
  })
  const tail = await client.beta.messages.countTokens({ model, messages })
  return { prefixTokens: full.input_tokens - tail.input_tokens, tailTokens: tail.input_tokens, model, promptVersion: PROMPT_VERSION }
}

/**
 * Characters per token of the whole prompt the agent builds (tools, instructions, the agent context, the dynamic files),
 * for an estimate without the token counter. Calibrated against `count_tokens` on prompt 5f (DECISIONS 75 Р2): 2.46 to
 * 2.62 for the prefix and 2.45 to 2.59 for the tail on the demo, shadcn-admin and TailAdmin; code alone is denser
 * (2.1 to 2.5, DECISIONS 73.5).
 */
export const CHARS_PER_TOKEN = 2.5

/**
 * The same split as `countPromptTokens`, estimated from the characters of the prompt the agent server would build
 * (no API call): the tools, the two system blocks and a short request. Used when there is no Anthropic key.
 */
export function estimatePromptTokens(manifest: PleatkitManifest, model = DEFAULT_MODEL): PromptTokenCount {
  const parts = buildPrompt(sampleRequest(manifest), undefined, digestsFromManifest(manifest))
  const tools = JSON.stringify(TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })))
  const tokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN)
  return { prefixTokens: tokens(tools.length + parts.instructions.length + parts.cached.length), tailTokens: tokens(parts.user.length), model, promptVersion: PROMPT_VERSION }
}
