import { costUsd, manifestReleaseHash, priceOf, type PleatkitManifest } from '@pleatkit/runtime/compiler'
import { estimatePromptTokens, type PromptTokenCount } from './prefix.js'
import { DEFAULT_CLASSIFIER_MODEL, DEFAULT_MODEL } from './providers/anthropic.js'
import type { ModelProvider } from './types.js'

/**
 * DECISIONS 75 (brainstorm 16, Р2): the expected price of one edit on an app before its first live request, from the
 * size of its prompt and the model price table, so a customer is not surprised by the bill. Shown by `pleatkit doctor`
 * and on the /admin Plan screen next to the measured cost per applied edit.
 *
 * The model of an edit (prompt 5f, the agent writes the request's tail to the cache on the first call):
 *
 *   first call   = prefix × cache read + tail × cache write + output × output price (+ 4 uncached tokens)
 *   second call  = (prefix + tail) × cache read + first turn × cache write + second output × output price
 *   expected     = first call + twoCallShare × second call + classifier (its fixed part read from the cache)
 *   cold         = the same with the prefix written instead of read (the first edit after the prefix's cache TTL:
 *                  an hour since block 6, 5 minutes before; a 1-hour write costs 2× input, a 5-minute one 1.25×) and
 *                  the classifier's fixed part written (5 minutes)
 *
 * The constants below were calibrated on the recorded live runs of prompt 5f and 5d (private evals: recordings/apps-5f,
 * probe-5f, live-5d, live-5d-sequential: 90 applied edits on the demo, shadcn-admin and TailAdmin):
 * - output of the first call: median output of one-call edits, 539 (shadcn-admin), 569 (TailAdmin), 475 (demo,
 *   5f), 597 (demo, 5d): 550;
 * - share of edits that needed a second call (a fix after `check`, a second file): 7 of 26 (apps-5f), 3 of 10
 *   (probe-5f), 10 of 54 (live-5d, both modes); 20 of 90 pooled: 0.22, rounded up to 0.25;
 * - second call: it writes the first turn (the first call's output and the tool results) to the cache, median 700
 *   tokens (cache writes of two-call edits minus the tail: 580 to 943), and outputs about 200 more tokens (median
 *   total output of two-call edits about 750 against 550 of one-call edits);
 * - classifier (Haiku 5.5): its fixed part read from the cache, median 1 534 to 2 675 tokens by app: 2 000; 40
 *   uncached request tokens; 90 output tokens. About $0.00007, under 1 % of an edit.
 */
export interface EditCostAssumptions {
  /** Output tokens of the first call of an edit. */
  outputTokens: number
  /** Share of edits that take a second call. */
  twoCallShare: number
  /** Output tokens of the second call. */
  secondCallOutputTokens: number
  /** Tokens the second call writes to the cache (the first turn: its output and the tool results). */
  secondCallWriteTokens: number
  /** Uncached input tokens per call (after the cache breakpoints). */
  uncachedTokens: number
  /** The request's tail is written to the cache on the first call. false since DECISIONS 76.1 (cacheTail
   * 'after-first' is the default): a one-call edit sends the tail as plain input, cheaper than a 1.25x write. */
  tailWrite: boolean
  /** The classifier's fixed part (instructions and the app's context), read from the cache. */
  classifierPrefixTokens: number
  classifierInputTokens: number
  classifierOutputTokens: number
  /** Block 6 (17 §21): the TTL of the system prefix's cache entry, which prices a cold edit's prefix write. */
  prefixTtl: '5m' | '1h'
}

export const EDIT_COST_ASSUMPTIONS: Readonly<EditCostAssumptions> = {
  outputTokens: 550,
  twoCallShare: 0.25,
  secondCallOutputTokens: 200,
  secondCallWriteTokens: 700,
  uncachedTokens: 4,
  tailWrite: false,
  classifierPrefixTokens: 2_000,
  classifierInputTokens: 40,
  classifierOutputTokens: 90,
  prefixTtl: '1h',
}

export interface PromptSize {
  /** Tokens of the cached prefix (tools, instructions, digests, the agent context). */
  prefixTokens: number
  /** Tokens of one request's own part (the dynamic files and a short request). */
  tailTokens: number
}

export interface ExpectedEditCost {
  model: string
  classifierModel: string | null
  prefixTokens: number
  tailTokens: number
  /** USD of a typical edit with a warm cache; null when the model is not in the price table. */
  expectedUsd: number | null
  /** USD of the first edit after 5 minutes idle (the prefix written to the cache again). */
  coldUsd: number | null
  /** Parts of `expectedUsd` (null when unpriced). */
  breakdown: {
    prefixReadUsd: number
    tailUsd: number
    outputUsd: number
    /** The second call, weighted by `twoCallShare`. */
    secondCallUsd: number
    classifierUsd: number
  } | null
  assumptions: EditCostAssumptions
  /** Models the price table does not know; when any is listed, the totals and the breakdown are null. */
  unpriced: string[]
}

/**
 * Predict the cost of a typical edit from the prompt size (counted by `countPromptTokens` or estimated by
 * `estimatePromptTokens`) and the price table. `classifierModel` null: no classifier call.
 */
export function expectedEditCost(size: PromptSize, model: string, classifierModel: string | null, overrides: Partial<EditCostAssumptions> = {}): ExpectedEditCost {
  const a: EditCostAssumptions = { ...EDIT_COST_ASSUMPTIONS, ...overrides }
  const P = Math.max(0, Math.round(size.prefixTokens))
  const T = Math.max(0, Math.round(size.tailTokens))
  const unpriced = [...new Set([model, ...(classifierModel ? [classifierModel] : [])])].filter((m) => !priceOf(m))
  const base = { model, classifierModel, prefixTokens: P, tailTokens: T, assumptions: a, unpriced }
  if (unpriced.length) return { ...base, expectedUsd: null, coldUsd: null, breakdown: null }

  const usd = (m: string, u: { input?: number; output?: number; read?: number; write?: number; write1h?: number }) =>
    costUsd(m, { inputTokens: u.input ?? 0, outputTokens: u.output ?? 0, cacheReadTokens: u.read ?? 0, cacheWriteTokens: (u.write ?? 0) + (u.write1h ?? 0), cacheWrite1hTokens: u.write1h ?? 0 })!
  const tail = a.tailWrite ? usd(model, { write: T }) : usd(model, { input: T })
  const prefixRead = usd(model, { read: P })
  const prefixWrite = a.prefixTtl === '1h' ? usd(model, { write1h: P }) : usd(model, { write: P })
  const output = usd(model, { input: a.uncachedTokens, output: a.outputTokens })
  const second = usd(model, { input: a.uncachedTokens, read: P + T, write: a.secondCallWriteTokens, output: a.secondCallOutputTokens }) * a.twoCallShare
  const classifierFixed = { input: a.classifierInputTokens, output: a.classifierOutputTokens }
  const classifierWarm = classifierModel ? usd(classifierModel, { ...classifierFixed, read: a.classifierPrefixTokens }) : 0
  const classifierCold = classifierModel ? usd(classifierModel, { ...classifierFixed, write: a.classifierPrefixTokens }) : 0
  return {
    ...base,
    expectedUsd: prefixRead + tail + output + second + classifierWarm,
    coldUsd: prefixWrite + tail + output + second + classifierCold,
    breakdown: { prefixReadUsd: prefixRead, tailUsd: tail, outputUsd: output, secondCallUsd: second, classifierUsd: classifierWarm },
  }
}

/** `$0.0361`: four decimals under a dollar, as the /admin screens and the report show money. */
export const formatUsd = (v: number): string => `$${v.toFixed(v >= 1 ? 2 : 4)}`

export interface AppExpectedCost extends ExpectedEditCost {
  /** `counted`: the prompt counted by the provider's token counter; `estimated`: from its characters. */
  source: 'counted' | 'estimated'
  promptVersion: string
  /** Why the numbers are estimated or priced as another model, in a sentence. */
  note?: string
}

/**
 * The expected cost of an edit on this app for the agent server (`POST /agent/v1/expected-cost`): the prompt counted
 * with the provider's `count_tokens` (Anthropic with a key; free) and cached per release and model in `cache`, else
 * estimated. The scripted demo provider has no prices: its numbers are those of the default models.
 */
export async function appExpectedCost(manifest: PleatkitManifest, provider: Pick<ModelProvider, 'name' | 'model' | 'clusterModel' | 'countPromptTokens'> | null, cache: Map<string, PromptTokenCount>): Promise<AppExpectedCost> {
  const scripted = !provider || provider.name === 'scripted'
  const main = scripted ? DEFAULT_MODEL : provider.model
  const classifier = scripted ? DEFAULT_CLASSIFIER_MODEL : (provider.clusterModel ?? null)
  let count: PromptTokenCount | null = null
  let note: string | undefined = scripted ? `no model provider with prices (${provider?.name ?? 'none'}): priced as ${DEFAULT_MODEL} with the ${DEFAULT_CLASSIFIER_MODEL} classifier` : undefined
  if (provider?.countPromptTokens) {
    const key = `${await manifestReleaseHash(manifest)}\0${main}`
    count = cache.get(key) ?? null
    if (!count) {
      try {
        count = await provider.countPromptTokens(manifest)
        cache.set(key, count)
        if (cache.size > 100) cache.delete(cache.keys().next().value!)
      } catch (e) {
        note = `the token counter failed (${(e as Error).message.split('\n')[0]!.slice(0, 160)}): estimated from characters`
      }
    }
  }
  const size = count ?? estimatePromptTokens(manifest, main)
  return { ...expectedEditCost(size, main, classifier), source: count ? 'counted' : 'estimated', promptVersion: size.promptVersion, ...(note ? { note } : {}) }
}
