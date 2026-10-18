import { hashFiles, sha256Hex, type CompileError, type FileMap, type PleatkitManifest } from '@pleatkit/runtime/compiler'
import { contextFromManifest, manifestPanels } from './manifest.js'
import { Workspace, type TypecheckFn } from './workspace.js'

/**
 * `pleatkit check-snapshots` (brainstorm 05 #4): before a release goes out, check every user's current version
 * against the new build. Each head is carried over the way the runtime does it (files the user did not change
 * come from the new release), then compiled with the new readonly sources, externals and rules, and type-checked
 * when a typechecker is given. The report lists the users whose version would be marked stale.
 */
export interface CheckSnapshotsOptions {
  storeUrl: string
  appId: string
  /** The app key (`mk_live_…`); without it the development admin header is used. */
  appKey?: string | null
  /** The new build's `pleatkit.manifest.json`. */
  manifest: PleatkitManifest
  typecheck?: TypecheckFn | null
  fetch?: typeof fetch
}

export interface SnapshotCheck {
  userId: string
  snapshotId: string
  ok: boolean
  /** Files the user changed (kept from their version); the rest comes from the new release. */
  userFiles: string[]
  errors: CompileError[]
}

interface ExportedSnapshot {
  id: string
  userId: string
  parentId: string | null
  files: FileMap
  baseFiles: Record<string, string> | null
}

export async function checkSnapshots(o: CheckSnapshotsOptions): Promise<{ checked: number; failed: number; results: SnapshotCheck[] }> {
  const f = o.fetch ?? ((...a) => globalThis.fetch(...a))
  const base = o.storeUrl.replace(/\/$/, '').replace(/\/v1$/, '') + '/v1'
  const res = await f(`${base}/admin/export`, {
    headers: { 'x-pleatkit-app': o.appId, ...(o.appKey ? { authorization: `Bearer ${o.appKey}` } : { 'x-pleatkit-admin': '1' }) },
  })
  if (!res.ok) throw new Error(`store-server export answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const doc = (await res.json()) as { snapshots: ExportedSnapshot[]; heads: { userId: string; snapshotId: string }[] }
  const byId = new Map(doc.snapshots.map((s) => [s.id, s]))
  const release: FileMap = Object.fromEntries(o.manifest.dynamic.map((x) => [x.path, x.source]))
  const releaseHash = await hashFiles(release)
  const results: SnapshotCheck[] = []
  for (const head of doc.heads) {
    const snap = byId.get(head.snapshotId)
    if (!snap || !snap.parentId) continue // the original version: nothing to check
    if ((await hashFiles(snap.files)) === releaseHash) continue
    // carry over like the runtime (V1 B5): the user's own changes on top of the new release
    let rootSnap = snap
    while (rootSnap.parentId && byId.has(rootSnap.parentId)) rootSnap = byId.get(rootSnap.parentId)!
    const oldBase: Record<string, string> = snap.baseFiles ?? {}
    if (!snap.baseFiles) for (const [p, s] of Object.entries(rootSnap.files)) oldBase[p] = (await sha256Hex(s)).slice(0, 32)
    const files: FileMap = { ...release }
    const userFiles: string[] = []
    for (const p of new Set([...Object.keys(oldBase), ...Object.keys(snap.files)])) {
      const mine = p in snap.files ? (await sha256Hex(snap.files[p]!)).slice(0, 32) : undefined
      if (mine === oldBase[p]) continue
      userFiles.push(p)
      if (p in snap.files) files[p] = snap.files[p]!
      else delete files[p]
    }
    const ws = new Workspace(
      {
        files,
        readonly: Object.fromEntries(o.manifest.readonly.map((x) => [x.path, x.source])),
        coreTypes: Object.fromEntries(o.manifest.coreTypes.map((x) => [x.path, x.source])),
        context: contextFromManifest(o.manifest, o.appId),
        components: manifestPanels(o.manifest),
        ...(o.manifest.protected?.length ? { protected: o.manifest.protected, base: release } : {}),
      },
      o.typecheck ?? null,
    )
    const r = await ws.check()
    results.push({ userId: head.userId, snapshotId: snap.id, ok: r.ok, userFiles: userFiles.sort(), errors: r.errors.slice(0, 5) })
  }
  return { checked: results.length, failed: results.filter((r) => !r.ok).length, results }
}
