import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { HeadConflictError } from '../errors.js'
import type { BundleCache, CompiledBundle, Snapshot, SnapshotStore } from '../types.js'

interface PleatkitDB extends DBSchema {
  snapshots: { key: string; value: Snapshot; indexes: { byUser: string } }
  heads: { key: string; value: { userId: string; id: string } }
  bundles: { key: string; value: { hash: string } & CompiledBundle }
}

/** IndexedDB-backed store for demos and desktop: everything stays in this browser profile. */
export class LocalStore implements SnapshotStore {
  private db: Promise<IDBPDatabase<PleatkitDB>>

  constructor(name = 'pleatkit') {
    this.db = openDB<PleatkitDB>(name, 1, {
      upgrade(db) {
        const snapshots = db.createObjectStore('snapshots', { keyPath: 'id' })
        snapshots.createIndex('byUser', 'userId')
        db.createObjectStore('heads', { keyPath: 'userId' })
        db.createObjectStore('bundles', { keyPath: 'hash' })
      },
    })
  }

  async head(userId: string): Promise<Snapshot | null> {
    const db = await this.db
    const head = await db.get('heads', userId)
    if (!head) return null
    return (await db.get('snapshots', head.id)) ?? null
  }

  async get(id: string): Promise<Snapshot> {
    const snapshot = await (await this.db).get('snapshots', id)
    if (!snapshot) throw new Error(`Snapshot ${id} not found`)
    return snapshot
  }

  async list(userId: string, limit = 50): Promise<Snapshot[]> {
    const all = await (await this.db).getAllFromIndex('snapshots', 'byUser', userId)
    // ULIDs sort by creation time
    return all.sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, limit)
  }

  async put(snapshot: Snapshot): Promise<void> {
    await (await this.db).put('snapshots', snapshot)
  }

  async setHead(userId: string, id: string, expectedHeadId?: string | null): Promise<void> {
    const db = await this.db
    // compare-and-set in one transaction, so two tabs of this browser cannot overwrite each other's head
    const tx = db.transaction('heads', 'readwrite')
    const current = (await tx.store.get(userId))?.id ?? null
    if (expectedHeadId !== undefined && expectedHeadId !== current) {
      tx.abort()
      await tx.done.catch(() => undefined)
      throw new HeadConflictError(expectedHeadId, current)
    }
    await tx.store.put({ userId, id })
    await tx.done
  }

  bundleCache: BundleCache = {
    get: async (hash) => {
      const row = await (await this.db).get('bundles', hash)
      return row ? { js: row.js, css: row.css } : null
    },
    put: async (hash, bundle) => {
      await (await this.db).put('bundles', { hash, ...bundle })
    },
  }
}
