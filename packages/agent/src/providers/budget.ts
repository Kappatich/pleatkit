/**
 * Ceiling of one model call (code review 06 item 10). `max_tokens` caps thinking and visible output together, so
 * it is the visible budget still left for this edit plus room to think, never more than 16k (non-streaming calls
 * stay inside the SDK's request-time limits) and never less than 1k (a finish call must fit).
 */
export const MAX_TOKENS_PER_CALL = 16_000
export const THINKING_HEADROOM = 8_000

export function perCallMaxTokens(remainingVisible: number): number {
  return Math.max(1_024, Math.min(MAX_TOKENS_PER_CALL, Math.floor(remainingVisible) + THINKING_HEADROOM))
}
