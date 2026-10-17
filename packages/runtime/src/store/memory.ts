import type { BundleCache, CompiledBundle, Snapshot, SnapshotStore } from '../types.js'
import { HeadConflictError } from '../errors.js'
import { clone } from '../util.js'

/** In-memory store for tests and SSR. */
export class MemoryStore implements SnapshotStore {
  private snapshots = new Map<string, Snapshot>()
  private heads = new Map<string, string>()
  private bundles = new Map<string, CompiledBundle>()

  async head(userId: string): Promise<Snapshot | null> {
    const id = this.heads.get(userId)
    return id ? this.get(id) : null
  }

  async get(id: string): Promise<Snapshot> {
    const s = this.snapshots.get(id)
    if (!s) throw new Error(`Snapshot ${id} not found`)
    return clone(s)
  }

  async list(userId: string, limit = 50): Promise<Snapshot[]> {
    return [...this.snapshots.values()]
      .filter((s) => s.userId === userId)
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, limit)
      .map(clone)
  }

  async put(snapshot: Snapshot): Promise<void> {
    this.snapshots.set(snapshot.id, clone(snapshot))
  }

  async setHead(userId: string, id: string, expectedHeadId?: string | null): Promise<void> {
    const current = this.heads.get(userId) ?? null
    if (expectedHeadId !== undefined && expectedHeadId !== current) throw new HeadConflictError(expectedHeadId, current)
    this.heads.set(userId, id)
  }

  bundleCache: BundleCache = {
    get: async (hash) => this.bundles.get(hash) ?? null,
    put: async (hash, bundle) => {
      this.bundles.set(hash, bundle)
    },
  }
}
