// Safe mode (V1 B2): an edit that hangs the tab (an endless loop in render or an effect) must not brick the app
// for its user. Before a user's version is made live the runtime writes a boot record; once the page has been
// responsive for a moment after the swap it marks the record mounted. If the previous load never got there and
// was not simply closed within the first seconds, the next start shows the original version with a banner.

export interface BootRecord {
  snapshotId: string
  /** When the version was made live, ms since the epoch. */
  at: number
  mounted: boolean
  /** Set by `pagehide` while still not mounted: the user left on their own. */
  closedAt?: number
  /** The page load that wrote it: a record of this very page is still pending, not failed. */
  page?: string
}

/** Id of this page load (one JS realm). */
export const PAGE_ID = Math.random().toString(36).slice(2, 10)

export interface BootStorage {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

/** A load that has not mounted within this time counts as failed (the user did not just close the tab quickly). */
export const SAFE_MODE_MOUNT_MS = 5_000
/** The page must stay responsive this long after the swap before the version counts as mounted. */
export const HEARTBEAT_MS = 1_000

/** localStorage, or null where it is unavailable (Node, sandboxed frames, disabled storage). */
export function browserBootStorage(): BootStorage | null {
  try {
    const ls = globalThis.localStorage
    if (!ls) return null
    const probe = '__pleatkit_probe__'
    ls.setItem(probe, '1')
    ls.removeItem(probe)
    return { get: (k) => ls.getItem(k), set: (k, v) => ls.setItem(k, v), remove: (k) => ls.removeItem(k) }
  } catch {
    return null
  }
}

export class MemoryBootStorage implements BootStorage {
  readonly map = new Map<string, string>()
  get(k: string) {
    return this.map.get(k) ?? null
  }
  set(k: string, v: string) {
    this.map.set(k, v)
  }
  remove(k: string) {
    this.map.delete(k)
  }
}

export function readBoot(storage: BootStorage | null, key: string): BootRecord | null {
  try {
    const raw = storage?.get(key)
    return raw ? (JSON.parse(raw) as BootRecord) : null
  } catch {
    return null
  }
}

export function writeBoot(storage: BootStorage | null, key: string, rec: BootRecord | null): void {
  try {
    if (!storage) return
    if (rec) storage.set(key, JSON.stringify(rec))
    else storage.remove(key)
  } catch {
    // storage full or blocked: safe mode is best effort
  }
}

/** Did the last load of `snapshotId` fail to mount (hang or crash), rather than being closed quickly? */
export function previousLoadFailed(rec: BootRecord | null, snapshotId: string, page: string = PAGE_ID): boolean {
  if (!rec || rec.mounted || rec.snapshotId !== snapshotId) return false
  // switching users or apps within one page re-creates the engine: that is not a previous load
  if (rec.page === page) return false
  return rec.closedAt === undefined || rec.closedAt - rec.at >= SAFE_MODE_MOUNT_MS
}

/**
 * Move a boot record from its pre-rename key (`morphkit:boot:…`, DECISIONS 68) to the current one, once: the
 * old key is removed, a record already under the new key wins.
 */
export function migrateBootKey(storage: BootStorage | null, legacyKey: string, key: string): void {
  try {
    const old = storage?.get(legacyKey)
    if (!storage || old === null || old === undefined) return
    if (storage.get(key) === null) storage.set(key, old)
    storage.remove(legacyKey)
  } catch {
    // storage blocked: safe mode is best effort
  }
}

/** `?pleatkit=safe` in the page URL forces the original version (`?morphkit=safe` too, for one release). */
export function safeModeRequested(): boolean {
  try {
    if (typeof location === 'undefined') return false
    const q = new URLSearchParams(location.search)
    return q.get('pleatkit') === 'safe' || q.get('morphkit') === 'safe'
  } catch {
    return false
  }
}
