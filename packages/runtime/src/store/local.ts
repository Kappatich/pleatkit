import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { HeadConflictError } from '../errors.js'
import type { BundleCache, CompiledBundle, Snapshot, SnapshotStore } from '../types.js'

interface PleatkitDB extends DBSchema {
  snapshots: { key: string; value: Snapshot; indexes: { byUser: string } }
  heads: { key: string; value: { userId: string; id: string } }
  bundles: { key: string; value: { hash: string } & CompiledBundle }
}

const STORES = ['snapshots', 'heads', 'bundles'] as const

/**
 * The database this one was called before the rename (DECISIONS 68): `pleatkit` ← `morphkit`,
 * `pleatkit-<app>` ← `morphkit-<app>`; null for a name the app chose without the product name.
 */
export function legacyDbName(name: string): string | null {
  return /^pleatkit(?=$|[-_:.])/.test(name) ? 'morphkit' + name.slice('pleatkit'.length) : null
}

/**
 * One-time migration: a database created just now gets every record of its pre-rename namesake, if that one
 * exists. The old database is left in place (nothing is deleted); it is read only when the new one is fresh.
 */
async function copyLegacy(db: IDBPDatabase<PleatkitDB>, legacy: string): Promise<void> {
  const idb = globalThis.indexedDB as (IDBFactory & { databases?: () => Promise<IDBDatabaseInfo[]> }) | undefined
  if (!idb?.databases) return
  const known = await idb.databases().catch(() => [] as IDBDatabaseInfo[])
  if (!known.some((d) => d.name === legacy)) return
  const old = await openDB<PleatkitDB>(legacy)
  try {
    const names = STORES.filter((s) => old.objectStoreNames.contains(s))
    if (!names.length) return
    const rows = await Promise.all(names.map(async (s) => [s, await old.getAll(s)] as const))
    const tx = db.transaction(names, 'readwrite')
    for (const [s, values] of rows) for (const v of values) void tx.objectStore(s).put(v as never)
    await tx.done
  } finally {
    old.close()
  }
}

/** IndexedDB-backed store for demos and desktop: everything stays in this browser profile. */
export class LocalStore implements SnapshotStore {
  private db: Promise<IDBPDatabase<PleatkitDB>>

  /** `migrateFrom`: the pre-rename database to copy from once (default: `legacyDbName(name)`; null: none). */
  constructor(name = 'pleatkit', options: { migrateFrom?: string | null } = {}) {
    let fresh = false
    const legacy = options.migrateFrom !== undefined ? options.migrateFrom : legacyDbName(name)
    this.db = openDB<PleatkitDB>(name, 1, {
      upgrade(db, oldVersion) {
        fresh = oldVersion === 0
        const snapshots = db.createObjectStore('snapshots', { keyPath: 'id' })
        snapshots.createIndex('byUser', 'userId')
        db.createObjectStore('heads', { keyPath: 'userId' })
        db.createObjectStore('bundles', { keyPath: 'hash' })
      },
    }).then(async (db) => {
      // a failed copy must not take the store down: the user starts from the original version instead
      if (fresh && legacy && legacy !== name) await copyLegacy(db, legacy).catch(() => undefined)
      return db
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
