// What the demo server uses of the agent package, in one place.
export { classifierContext, createAgentApp, loadFixtures, providerFromEnv, runAgent, ScriptedProvider, createTypechecker, loadManifest } from '@pleatkit/agent'
export type { AgentRunner, ModelProvider, Classification, ClassifyInput, ModelSession, PromptParts, ToolSpec } from '@pleatkit/agent'
export type { AgentResult, AgentRunRequest, TokenUsage } from '@pleatkit/runtime/compiler'
import type { TokenUsage } from '@pleatkit/runtime/compiler'

export const emptyUsageOf = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
