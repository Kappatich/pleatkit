import { createHash, randomBytes } from 'node:crypto'
import { hashFiles } from '@pleatkit/runtime/compiler'
import { rawDb, type ErasureSubject, type StoreDb, type StoreExtension } from './extension.js'

/**
 * DECISIONS 70.2, the right to erasure of the DPA: everything the store keeps about one user of an app, or about
 * the whole app, is deleted in one transaction: snapshots and heads, the request log, usage events (metering),
 * cached and signed bundles made from the user's files, run records, idempotency replies, quota buckets,
 * user flags, carry-over rows, references in wish maps, and the extensions' rows (the cloud's L1 facts). What
 * stays is one audit row, the tombstone, with the counts and a random id but no personal data. A user's erasure
 * keeps the app's audit chain (other users' rows are hash-linked to it); an app's erasure deletes the chain too
 * and the tombstone starts a new one. `DELETE /v1/admin/users/:id`, `DELETE /v1/admin/apps/:id`, `pleatkit erase`.
 */
export type ErasureCounts = Record<string, number>

interface Part {
  name: string
  /** SQL `FROM <table> WHERE …` with positional parameters. */
  from: string
  params: unknown[]
}

/** The rows of a user: by user id, by request id, by the user-keyed names the core gives buckets and callers. */
function userParts(appId: string, userId: string): Part[] {
  const reqs = 'SELECT id FROM requests WHERE app_id = ? AND user_id = ?'
  const prefix = `user:${userId}:`
  return [
    { name: 'events', from: `events WHERE app_id = ? AND (user_id = ? OR request_id IN (${reqs}))`, params: [appId, userId, appId, userId] },
    { name: 'requests', from: 'requests WHERE app_id = ? AND user_id = ?', params: [appId, userId] },
    { name: 'heads', from: 'heads WHERE app_id = ? AND user_id = ?', params: [appId, userId] },
    { name: 'snapshots', from: 'snapshots WHERE app_id = ? AND user_id = ?', params: [appId, userId] },
    { name: 'bundles_owned', from: 'bundle_files WHERE app_id = ? AND owner = ?', params: [appId, userId] },
    { name: 'agent_runs', from: 'agent_runs WHERE app_id = ? AND user_id = ?', params: [appId, userId] },
    { name: 'idempotency', from: 'idempotency WHERE app_id = ? AND (caller = ? OR substr(caller, 1, ?) = ?)', params: [appId, `agent:${userId}`, prefix.length, prefix] },
    { name: 'quota_buckets', from: 'quota_buckets WHERE app_id = ? AND substr(key, 1, ?) = ?', params: [appId, prefix.length, prefix] },
    { name: 'flags', from: "flags WHERE app_id = ? AND scope = 'user' AND scope_id = ?", params: [appId, userId] },
    { name: 'release_items', from: 'release_items WHERE app_id = ? AND user_id = ?', params: [appId, userId] },
  ]
}

const APP_TABLES = ['events', 'requests', 'heads', 'snapshots', 'bundle_files', 'bundles', 'agent_runs', 'idempotency', 'quota_buckets', 'flags', 'releases', 'release_items', 'wish_maps', 'app_plans', 'app_settings', 'audit']

function appParts(appId: string): Part[] {
  return APP_TABLES.map((t) => ({ name: t, from: `${t} WHERE app_id = ?`, params: [appId] }))
}

/**
 * Signed bundles compiled from the user's files (by the `filesHash` they were signed for) and legacy bundles by
 * files hash. The user's root snapshot is the app's release, shared by everyone, and is left out. A bundle another
 * user happens to share is compiled again on their next load (bundles are derived from snapshots).
 */
async function userBundles(db: StoreDb, appId: string, userId: string): Promise<{ signed: string[]; legacy: string[] }> {
  const raw = rawDb(db)
  const rows = raw.prepare('SELECT parent_id AS parentId, files FROM snapshots WHERE app_id = ? AND user_id = ?').all(appId, userId) as { parentId: string | null; files: string }[]
  const hashes = new Set<string>()
  for (const r of rows) if (r.parentId) hashes.add(await hashFiles(JSON.parse(r.files) as Record<string, string>))
  if (!hashes.size) return { signed: [], legacy: [] }
  const signed = (raw.prepare("SELECT key, signature FROM bundle_files WHERE app_id = ? AND owner = '' AND signature IS NOT NULL").all(appId) as { key: string; signature: string }[])
    .filter((b) => {
      try {
        return hashes.has((JSON.parse(b.signature) as { payload?: { filesHash?: string } }).payload?.filesHash ?? '')
      } catch {
        return false
      }
    })
    .map((b) => b.key)
  const legacy = (raw.prepare('SELECT hash FROM bundles WHERE app_id = ?').all(appId) as { hash: string }[]).map((b) => b.hash).filter((h) => hashes.has(h))
  return { signed, legacy }
}

/** Request ids of the user that wish maps refer to (the map keeps the rest of each theme). */
function wishRefs(db: StoreDb, appId: string, userId: string): { seq: number; clusters: { requestIds: string[] }[]; drop: Set<string> }[] {
  const raw = rawDb(db)
  const ids = new Set((raw.prepare('SELECT id FROM requests WHERE app_id = ? AND user_id = ?').all(appId, userId) as { id: string }[]).map((r) => r.id))
  if (!ids.size) return []
  return (raw.prepare('SELECT seq, clusters FROM wish_maps WHERE app_id = ?').all(appId) as { seq: number; clusters: string }[])
    .map((m) => ({ seq: m.seq, clusters: JSON.parse(m.clusters) as { requestIds: string[] }[], drop: ids }))
    .filter((m) => m.clusters.some((k) => k.requestIds.some((id) => ids.has(id))))
}

export interface ErasurePlan {
  subject: ErasureSubject
  counts: ErasureCounts
  /** What the caller must send back to erase (`?confirm=`): it changes whenever the counts do. */
  confirm: string
}

async function plan(db: StoreDb, subject: ErasureSubject, extensions: readonly StoreExtension[]) {
  const raw = rawDb(db)
  const parts = subject.userId ? userParts(subject.appId, subject.userId) : appParts(subject.appId)
  const counts: ErasureCounts = {}
  for (const p of parts) counts[p.name] = (raw.prepare(`SELECT count(*) AS n FROM ${p.from}`).get(...p.params) as { n: number }).n
  const bundles = subject.userId ? await userBundles(db, subject.appId, subject.userId) : { signed: [], legacy: [] }
  const wishes = subject.userId ? wishRefs(db, subject.appId, subject.userId) : []
  if (subject.userId) {
    counts.bundles_signed = bundles.signed.length
    counts.bundles_legacy = bundles.legacy.length
    counts.wish_map_refs = wishes.reduce((n, m) => n + m.clusters.reduce((k, c) => k + c.requestIds.filter((id) => m.drop.has(id)).length, 0), 0)
  }
  for (const ext of extensions) for (const [k, v] of Object.entries(ext.count?.(db, subject) ?? {})) counts[`${ext.name}:${k}`] = v
  return { parts, counts, bundles, wishes }
}

const tokenOf = (subject: ErasureSubject, counts: ErasureCounts) =>
  createHash('sha256')
    .update(JSON.stringify([subject.appId, subject.userId, Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))]))
    .digest('hex')
    .slice(0, 16)

/** What an erasure would delete, and the confirm token for exactly that. Writes nothing. */
export async function planErasure(db: StoreDb, subject: ErasureSubject, extensions: readonly StoreExtension[] = []): Promise<ErasurePlan> {
  const { counts } = await plan(db, subject, extensions)
  return { subject, counts, confirm: tokenOf(subject, counts) }
}

/** A random id for the tombstone: it names the erasure (the admin keeps it with the ticket), not the subject. */
export const tombstoneId = () => `erased:${randomBytes(8).toString('hex')}`

/**
 * Delete the subject's rows when `confirm` matches what is there now; otherwise nothing changes and the caller
 * gets the current counts and token. The caller appends the tombstone to the audit chain afterwards.
 */
export async function eraseSubject(
  db: StoreDb,
  subject: ErasureSubject,
  confirm: string | null | undefined,
  extensions: readonly StoreExtension[] = [],
): Promise<{ erased: true; counts: ErasureCounts } | { erased: false; plan: ErasurePlan }> {
  const p = await plan(db, subject, extensions)
  const token = tokenOf(subject, p.counts)
  if (confirm !== token) return { erased: false, plan: { subject, counts: p.counts, confirm: token } }
  const raw = rawDb(db)
  const counts: ErasureCounts = {}
  raw.transaction(() => {
    raw.prepare('INSERT INTO erasing (app_id, scope) VALUES (?, ?)').run(subject.appId, subject.userId ? 'user' : 'app')
    // extensions first: their rows may be keyed by the request ids the core deletes next
    for (const ext of extensions) for (const [k, v] of Object.entries(ext.erase?.(db, subject) ?? {})) counts[`${ext.name}:${k}`] = v
    for (const part of p.parts) counts[part.name] = raw.prepare(`DELETE FROM ${part.from}`).run(...part.params).changes
    if (subject.userId) {
      const delSigned = raw.prepare("DELETE FROM bundle_files WHERE app_id = ? AND owner = '' AND key = ?")
      counts.bundles_signed = p.bundles.signed.reduce((n, key) => n + delSigned.run(subject.appId, key).changes, 0)
      const delLegacy = raw.prepare('DELETE FROM bundles WHERE app_id = ? AND hash = ?')
      counts.bundles_legacy = p.bundles.legacy.reduce((n, h) => n + delLegacy.run(subject.appId, h).changes, 0)
      let refs = 0
      const setClusters = raw.prepare('UPDATE wish_maps SET clusters = ? WHERE seq = ?')
      for (const m of p.wishes) {
        const clusters = m.clusters
          .map((k) => {
            const kept = k.requestIds.filter((id) => !m.drop.has(id))
            refs += k.requestIds.length - kept.length
            return { ...k, requestIds: kept }
          })
          .filter((k) => k.requestIds.length > 0)
        setClusters.run(JSON.stringify(clusters), m.seq)
      }
      counts.wish_map_refs = refs
    }
    raw.prepare('DELETE FROM erasing WHERE app_id = ?').run(subject.appId)
  })()
  return { erased: true, counts }
}
