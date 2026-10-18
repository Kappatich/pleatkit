/**
 * Stage 5 block 3: model calls under the provider's rate limits (Anthropic's Start tier: per model 2M input tokens,
 * 400K output tokens and 1,000 requests a minute).
 *
 * - A per-process cap on concurrent model calls (`PLEATKIT_MODEL_CONCURRENCY`, default 8) with a FIFO queue, so a burst
 *   of edits waits its turn instead of hitting the limit all at once.
 * - A rate-limited call (HTTP 429, or 529 / `overloaded_error`) is retried after the provider's `retry-after`, else
 *   with exponential backoff (1 s, 2 s, 4 s, jittered), at most `PLEATKIT_RATE_LIMIT_RETRIES` times (default 3); the
 *   run shows a "busy, retrying" step meanwhile. Other transient errors (408, 409, 5xx, a dropped connection) are
 *   retried the same way without the step. The SDK's own retries are off, so these are the only ones.
 * - A retry is not started when its wait would not end before the run's deadline: the run fails at once with
 *   `rateLimited: true` instead of paying for a call the timeout would cancel.
 */

export interface RetryInfo {
  /** 1 for the first retry. */
  attempt: number
  waitMs: number
  /** HTTP status of the refused call (429, 529), or null for a connection error. */
  status: number | null
  rateLimited: boolean
}

/** The run gave up on a rate-limited (or overloaded) provider. */
export class RateLimitedError extends Error {
  readonly rateLimited = true
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message)
    this.name = 'RateLimitedError'
  }
}

/** A FIFO semaphore: at most `max` calls at a time; the rest wait in the order they came. */
export class ModelGate {
  private active = 0
  private readonly waiting: { resolve: () => void; signal?: AbortSignal; onAbort?: () => void }[] = []

  constructor(private max: number) {}

  get limit(): number {
    return this.max
  }

  /** Calls running and calls queued (for health checks and tests). */
  get load(): { active: number; queued: number } {
    return { active: this.active, queued: this.waiting.length }
  }

  resize(max: number): void {
    this.max = Math.max(1, Math.floor(max))
    this.drain()
  }

  private drain(): void {
    while (this.active < this.max && this.waiting.length) {
      const next = this.waiting.shift()!
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort)
      this.active++
      next.resolve()
    }
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    if (this.active < this.max && this.waiting.length === 0) this.active++
    else {
      await new Promise<void>((resolve, reject) => {
        const entry: (typeof this.waiting)[number] = { resolve, signal }
        if (signal) {
          entry.onAbort = () => {
            const i = this.waiting.indexOf(entry)
            if (i >= 0) this.waiting.splice(i, 1)
            reject(signal.reason ?? new Error('aborted'))
          }
          signal.addEventListener('abort', entry.onAbort, { once: true })
        }
        this.waiting.push(entry)
      })
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.drain()
    }
  }
}

/** The process-wide gate the agent loop uses (resized from PLEATKIT_MODEL_CONCURRENCY by the server). */
export const DEFAULT_MODEL_CONCURRENCY = 8
export const DEFAULT_RATE_LIMIT_RETRIES = 3
export const modelGate = new ModelGate(DEFAULT_MODEL_CONCURRENCY)

interface ErrorLike {
  status?: unknown
  headers?: unknown
  error?: unknown
  message?: unknown
  name?: unknown
}

const header = (headers: unknown, name: string): string | null => {
  if (!headers) return null
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name)
  const v = (headers as Record<string, unknown>)[name]
  return typeof v === 'string' ? v : null
}

/** `retry-after-ms`, `retry-after` (seconds or an HTTP date), in milliseconds; null when absent. */
export function retryAfterMs(headers: unknown, now = Date.now()): number | null {
  const ms = Number(header(headers, 'retry-after-ms'))
  if (Number.isFinite(ms) && ms > 0) return ms
  const raw = header(headers, 'retry-after')
  if (!raw) return null
  const s = Number(raw)
  if (Number.isFinite(s)) return Math.max(0, s * 1000)
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

/** How a failed call should be treated: a rate limit, another transient error, or not retried at all. */
export function classifyFailure(e: unknown): { kind: 'rate-limit' | 'transient' | 'fatal'; status: number | null; retryAfterMs: number | null } {
  const err = (e ?? {}) as ErrorLike
  const status = typeof err.status === 'number' ? err.status : null
  const body = JSON.stringify(err.error ?? '') + String(err.message ?? '')
  const after = retryAfterMs(err.headers)
  if (status === 429 || status === 529 || /overloaded_error|rate_limit_error/.test(body)) return { kind: 'rate-limit', status, retryAfterMs: after }
  if (status === 408 || status === 409 || (status !== null && status >= 500)) return { kind: 'transient', status, retryAfterMs: after }
  if (status === null && /APIConnectionError|ECONNRESET|socket hang up|fetch failed/i.test(`${String(err.name ?? '')} ${String(err.message ?? '')}`)) return { kind: 'transient', status, retryAfterMs: null }
  return { kind: 'fatal', status, retryAfterMs: null }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('aborted'))
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

export interface CallOptions {
  signal: AbortSignal
  /** `performance.now()` by which the run must end: a retry whose wait ends later is not started. */
  deadline: number
  gate?: ModelGate
  retries?: number
  /** First backoff without `retry-after` (doubled per retry, ±20 % jitter). Default 1 s. */
  baseMs?: number
  /** Longest wait honoured; a longer `retry-after` gives up. Default 30 s. */
  maxWaitMs?: number
  onRetry?: (info: RetryInfo) => void
  random?: () => number
}

/** One model call through the gate, retried on rate limits and transient errors (see the module comment). */
export async function callModel<T>(fn: () => Promise<T>, o: CallOptions): Promise<T> {
  const gate = o.gate ?? modelGate
  const retries = o.retries ?? DEFAULT_RATE_LIMIT_RETRIES
  const base = o.baseMs ?? 1000
  const maxWait = o.maxWaitMs ?? 30_000
  const random = o.random ?? Math.random
  for (let attempt = 0; ; attempt++) {
    const release = await gate.acquire(o.signal)
    let failure: unknown
    try {
      return await fn()
    } catch (e) {
      failure = e
    } finally {
      // the slot is not held while waiting to retry
      release()
    }
    if (o.signal.aborted) throw failure
    const f = classifyFailure(failure)
    if (f.kind === 'fatal') throw failure
    const limited = f.kind === 'rate-limit'
    const giveUp = (why: string) => {
      if (!limited) return failure
      return new RateLimitedError(`the model provider is rate-limited (${f.status ?? 'no status'}): ${why}`, f.status)
    }
    if (attempt >= retries) throw giveUp(`${attempt + 1} attempts`)
    const backoff = base * 2 ** attempt * (0.8 + 0.4 * random())
    const waitMs = Math.round(f.retryAfterMs ?? backoff)
    if (waitMs > maxWait) throw giveUp(`retry-after ${Math.round(waitMs / 1000)} s is longer than ${Math.round(maxWait / 1000)} s`)
    // no retry the run's deadline would cancel: give up now, before paying for it
    if (performance.now() + waitMs + 1000 > o.deadline) throw giveUp('the next attempt would not finish before the run times out')
    o.onRetry?.({ attempt: attempt + 1, waitMs, status: f.status, rateLimited: limited })
    await sleep(waitMs, o.signal)
  }
}
