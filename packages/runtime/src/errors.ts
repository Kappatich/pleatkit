// Errors with codes, so callers can tell them apart without parsing messages (code review 06 §1).

/** The head moved since this tab last read it (another tab or device, an admin rollback): refresh and retry. */
export class HeadConflictError extends Error {
  readonly code = 'head-conflict'
  constructor(
    readonly expected: string | null,
    readonly actual: string | null | undefined,
  ) {
    super(`morphkit: your version changed elsewhere (expected head ${expected ?? 'none'}, found ${actual ?? 'unknown'}); reloaded it, try again`)
    this.name = 'HeadConflictError'
  }
}

/** The store (or another morphkit server) did not answer in time. */
export class StoreUnavailableError extends Error {
  readonly code = 'store-unavailable'
  constructor(message: string) {
    super(message)
    this.name = 'StoreUnavailableError'
  }
}

/** Reject after `ms` unless `p` settles first. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  if (!(ms > 0) || !Number.isFinite(ms)) return p
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StoreUnavailableError(`${what} did not answer within ${Math.round(ms / 100) / 10} s`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}
