import type { PleatkitManifest } from '@pleatkit/runtime/compiler'
import type { PromptTokenCount } from '../prefix.js'
import type { BackendQuote, Classification, ClassifyInput, JsonCall, JsonOutput, ModelProvider, ModelSession, PromptParts, ToolSpec } from '../types.js'

/**
 * Stage 5 block 7 (DECISIONS 78): the main model from one provider, the classifier from another
 * (`PLEATKIT_CLASSIFIER_PROVIDER`): e.g. an editor through OpenRouter with Haiku as the classifier, or Sonnet as the
 * editor with a cheap classifier through OpenRouter. The edit loop and the prompt's token count go to `main`; the
 * classification, the backend quote and JSON calls go to `classifier`.
 */
export class SplitProvider implements ModelProvider {
  readonly name: string
  readonly model: string
  readonly classifierModel: string | undefined
  readonly completeJson?: (call: JsonCall, signal: AbortSignal) => Promise<JsonOutput>
  readonly quoteBackend?: (input: ClassifyInput, signal: AbortSignal) => Promise<BackendQuote>
  readonly countPromptTokens?: (manifest: PleatkitManifest) => Promise<PromptTokenCount>

  constructor(
    readonly main: ModelProvider,
    readonly classifier: ModelProvider,
  ) {
    this.name = main.name
    this.model = main.model
    this.classifierModel = classifier.classifierModel
    if (classifier.completeJson) this.completeJson = (call, signal) => classifier.completeJson!(call, signal)
    if (classifier.quoteBackend) this.quoteBackend = (input, signal) => classifier.quoteBackend!(input, signal)
    if (main.countPromptTokens) this.countPromptTokens = (manifest) => main.countPromptTokens!(manifest)
  }

  classify(input: ClassifyInput, signal: AbortSignal): Promise<Classification> {
    return this.classifier.classify(input, signal)
  }

  start(prompt: PromptParts, tools: ToolSpec[], meta: { request: string }): ModelSession {
    return this.main.start(prompt, tools, meta)
  }
}
