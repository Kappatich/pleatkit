import { changedPaths, fileHashes, manifestReleaseHash, ulid, type AgentRunRequest, type FileMap, type PleatkitManifest } from '@pleatkit/runtime/compiler'
import { runAgent } from './loop.js'
import { contextFromManifest, manifestPanels, trustedInput } from './manifest.js'
import { resolvePlan } from './quota.js'
import type { ModelProvider } from './types.js'
import { Workspace, type TypecheckFn } from './workspace.js'

/**
 * C10 (brainstorm 05 #15): after a release, carry every user's edits over to it in one run with a dollar budget,
 * instead of 300 users pressing "carry over" on their own. Per user, the way the runtime does it (V1 B5): when the
 * release did not touch the files the user changed, the user's files go on top of the new release (no model);
 * otherwise the agent migrates them (`migration` request), within what is left of the budget. The store records
 * every user's outcome, so a stopped run resumes where it stopped, and `rollbackRelease` restores the heads.
 */
export const MIGRATE_REQUEST = 'Carry my customizations over to the new version of the app'
export const CARRIED_MESSAGE = 'Carried over to the new version of the app'

export type CarryState = 'carried' | 'migrated' | 'current' | 'stale' | 'budget' | 'failed' | 'moved'

export interface CarryOverOptions {
  storeUrl: string
  appId: string
  /** The app key (`mk_live_…`); without it the development admin header (and the user header) are used. */
  appKey?: string | null
  /** The new build's `pleatkit.manifest.json`. */
  manifest: PleatkitManifest
  /**
   * The release id the operator expects (`--release <hash>`): the manifest's release hash or a prefix of it (at
   * least 8 characters), so a run never carries edits to a build other than the one named.
   */
  release: string
  /** Dollars the agent may spend on this release in total, earlier attempts of the run included. */
  budgetUsd: number
  /** The agent for edits the release also changed; without one those users stay `stale`. */
  provider?: ModelProvider | null
  /**
   * Most one migration may cost (`--per-user-usd`). A migration starts only while this whole amount fits in what is
   * left of the budget, so a run never spends past it. Without it (DECISIONS 70.4) the cap is the `perEditUsd` of
   * the app's plan in store-server, else of `plan` (the agent's PLEATKIT_PLAN / PLEATKIT_LIMITS), else of `free`.
   */
  perUserUsd?: number
  /** The plan to use when store-server has none for the app (PLEATKIT_PLAN / PLEATKIT_LIMITS). */
  plan?: { name?: string; limits?: Record<string, number> }
  /** Resume also retries users whose migration failed or was declined earlier (`stale`, `failed`). */
  retry?: boolean
  typecheck?: TypecheckFn | null
  fetch?: typeof fetch
  log?: (line: string) => void
  /** Plan only: report what would happen, write nothing. */
  dryRun?: boolean
}

export interface CarryItem {
  userId: string
  from: string
  to: string | null
  state: CarryState
  costUsd: number
  error?: string
}

export interface CarryOverResult {
  release: string
  status: 'done' | 'budget' | 'dry-run'
  spentUsd: number
  budgetUsd: number
  /** Users handled in this invocation (users done in an earlier one are in `skipped`). */
  items: CarryItem[]
  /** The per-user cap the run used, and where it came from. */
  perUserUsd: number
  perUserSource: 'flag' | 'plan'
  plan: string
  skipped: number
  counts: Record<string, number>
}

interface ExportedSnapshot {
  id: string
  userId: string
  parentId: string | null
  files: FileMap
  baseFiles: Record<string, string> | null
  baseHash: string | null
  orgId?: string
}

/** States that are final for a run: a resume does not touch these users again (`stale`/`failed` only with `retry`). */
const DONE: CarryState[] = ['carried', 'migrated', 'current', 'moved']
const RETRYABLE: CarryState[] = ['stale', 'failed']

class Store {
  readonly base: string
  constructor(
    url: string,
    private readonly appId: string,
    private readonly appKey: string | null,
    private readonly f: typeof fetch,
  ) {
    this.base = url.replace(/\/$/, '').replace(/\/v1$/, '') + '/v1'
  }
  headers(userId?: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-pleatkit-app': this.appId,
      ...(this.appKey ? { authorization: `Bearer ${this.appKey}` } : { 'x-pleatkit-admin': '1' }),
      ...(userId ? { 'x-pleatkit-user': userId } : {}),
    }
  }
  async call<T>(method: string, path: string, body?: unknown, userId?: string, okStatuses: number[] = []): Promise<{ status: number; body: T }> {
    const res = await this.f(`${this.base}${path}`, { method, headers: this.headers(userId), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await res.text()
    if (!res.ok && !okStatuses.includes(res.status)) throw new Error(`store-server ${method} ${path} answered ${res.status}: ${text.slice(0, 200)}`)
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T }
  }
}

/** The release hash of a manifest, checked against the id the operator gave. */
export async function resolveRelease(manifest: PleatkitManifest, release: string): Promise<string> {
  const hash = await manifestReleaseHash(manifest)
  const want = release.trim().toLowerCase()
  if (want.length < 8 || !hash.startsWith(want)) {
    throw new Error(`--release ${release} is not this build: its manifest's release hash is ${hash} (pass it, or a prefix of 8+ characters)`)
  }
  return hash
}

export async function carryOverRelease(o: CarryOverOptions): Promise<CarryOverResult> {
  const log = o.log ?? (() => undefined)
  const store = new Store(o.storeUrl, o.appId, o.appKey ?? null, o.fetch ?? ((...a) => globalThis.fetch(...a)))
  const hash = await resolveRelease(o.manifest, o.release)
  const runId = hash.slice(0, 16)
  const release: FileMap = Object.fromEntries(o.manifest.dynamic.map((x) => [x.path, x.source]))
  const newBase = await fileHashes(release)
  const trusted = trustedInput(o.manifest, o.appId, { context: contextFromManifest(o.manifest, o.appId), readonly: {}, coreTypes: {}, components: [] })

  const doc = (await store.call<{ snapshots: ExportedSnapshot[]; heads: { userId: string; snapshotId: string }[] }>('GET', '/admin/export')).body
  const byId = new Map(doc.snapshots.map((s) => [s.id, s]))
  let done = new Map<string, { state: string; costUsd: number }>()
  let spent = 0
  if (!o.dryRun) {
    const started = (await store.call<{ release: { spentUsd: number }; items: { userId: string; state: string; costUsd: number }[] }>('PUT', `/admin/releases/${runId}`, { budgetUsd: o.budgetUsd })).body
    spent = started.release.spentUsd
    done = new Map(started.items.map((i) => [i.userId, i]))
  }
  // DECISIONS 70.4: the per-user cap is the app's plan's per-edit limit unless the operator gave one
  const stored = o.perUserUsd === undefined ? (await store.call<{ plan: string | null; limits: Record<string, number> }>('GET', '/plan')).body : null
  const planName = stored?.plan ?? o.plan?.name ?? 'free'
  const cap = o.perUserUsd ?? resolvePlan(planName, { ...o.plan?.limits, ...stored?.limits }).perEditUsd
  log(`per-user cap $${cap.toFixed(2)} (${o.perUserUsd === undefined ? `plan ${planName}` : '--per-user-usd'})`)
  const items: CarryItem[] = []
  let skipped = 0
  let budgetHit = false
  const record = async (item: CarryItem) => {
    items.push(item)
    log(`${item.state.padEnd(8)} ${item.userId}${item.costUsd ? ` $${item.costUsd.toFixed(4)}` : ''}${item.error ? ` (${item.error})` : ''}`)
    if (o.dryRun) return
    await store.call('PUT', `/admin/releases/${runId}/items/${encodeURIComponent(item.userId)}`, { fromSnapshot: item.from, toSnapshot: item.to, state: item.state, costUsd: item.costUsd, error: item.error ?? null })
  }

  /** A new snapshot on top of the user's head, made the head only if the head is still the one we read. */
  const commit = async (head: ExportedSnapshot, files: FileMap, message: string, author: 'user' | 'agent'): Promise<string | null> => {
    const snap = { id: ulid(), parentId: head.id, userId: head.userId, files, message, author, createdAt: new Date().toISOString(), status: 'applied', baseHash: hash, baseFiles: newBase, schemaVersion: 2 }
    await store.call('PUT', `/snapshots/${snap.id}`, snap, head.userId)
    const moved = await store.call('POST', `/snapshots/${snap.id}/head`, { expectedHeadId: head.id }, head.userId, [409])
    return moved.status === 409 ? null : snap.id
  }

  for (const h of [...doc.heads].sort((a, b) => a.userId.localeCompare(b.userId))) {
    const head = byId.get(h.snapshotId)
    if (!head?.parentId) continue // the original version: nothing to carry
    const prev = done.get(h.userId)
    if (prev && (DONE.includes(prev.state as CarryState) || (!o.retry && RETRYABLE.includes(prev.state as CarryState)))) {
      skipped++
      continue
    }
    // made on this release, or before releases were recorded (the runtime never calls those stale either)
    if (!head.baseHash || head.baseHash === hash) {
      await record({ userId: h.userId, from: head.id, to: null, state: 'current', costUsd: 0 })
      continue
    }
    let root = head
    while (root.parentId && byId.has(root.parentId)) root = byId.get(root.parentId)!
    const oldBase = head.baseFiles ?? (await fileHashes(root.files))
    const released = changedPaths(oldBase, newBase)
    const touched = changedPaths(oldBase, await fileHashes(head.files))
    const conflicts = released.filter((p) => touched.includes(p))
    const ws = (files: FileMap) =>
      new Workspace(
        { files, readonly: trusted.readonly, coreTypes: trusted.coreTypes, context: trusted.context, components: manifestPanels(o.manifest), ...(trusted.protected.length ? { protected: trusted.protected, base: release } : {}) },
        o.typecheck ?? null,
      )
    // 1. no file both sides changed: the user's files on top of the release, if that compiles (no model)
    if (!conflicts.length) {
      const files = { ...release }
      for (const p of touched) {
        if (p in head.files) files[p] = head.files[p]!
        else delete files[p]
      }
      if ((await ws(files).check()).ok) {
        const to = o.dryRun ? null : await commit(head, files, CARRIED_MESSAGE, 'user')
        await record({ userId: h.userId, from: head.id, to, state: o.dryRun || to ? 'carried' : 'moved', costUsd: 0 })
        continue
      }
    }
    // 2. the agent migrates the edits, if there is a provider and money left
    if (!o.provider) {
      await record({ userId: h.userId, from: head.id, to: null, state: 'stale', costUsd: 0, error: 'no agent provider: the user decides in the app' })
      continue
    }
    const left = o.budgetUsd - spent
    // a migration starts only when its whole cap fits in what is left: the run never spends past the budget
    if (budgetHit || left < cap) {
      budgetHit = true
      await record({ userId: h.userId, from: head.id, to: null, state: 'budget', costUsd: 0 })
      continue
    }
    if (o.dryRun) {
      await record({ userId: h.userId, from: head.id, to: null, state: 'migrated', costUsd: 0 })
      continue
    }
    const req: AgentRunRequest = {
      userId: h.userId,
      appId: o.appId,
      request: MIGRATE_REQUEST,
      files: release,
      readonly: trusted.readonly,
      coreTypes: trusted.coreTypes,
      context: trusted.context,
      components: trusted.components,
      migration: { oldBase: root.files, edited: head.files },
    }
    let result
    try {
      result = await runAgent(req, o.provider, {
        limits: { maxCostUsd: cap },
        protected: trusted.protected,
        base: trusted.base,
        typecheck: o.typecheck ?? null,
        ...(o.manifest.designSystem || o.manifest.dataContracts ? { digests: { ...(o.manifest.designSystem ? { designSystem: o.manifest.designSystem } : {}), ...(o.manifest.dataContracts ? { dataContracts: o.manifest.dataContracts } : {}) } } : {}),
      })
    } catch (e) {
      await record({ userId: h.userId, from: head.id, to: null, state: 'failed', costUsd: 0, error: (e as Error).message.slice(0, 300) })
      continue
    }
    const cost = result.usage.reduce((s, u) => s + (u.costUsd ?? 0), 0)
    spent += cost
    if (result.verdict !== 'ok' || (!Object.keys(result.files).length && !result.deleted.length)) {
      // the user keeps their version and sees the "app was updated" banner, as without the bulk run
      await record({ userId: h.userId, from: head.id, to: null, state: result.stopReason === 'cost' ? 'budget' : 'stale', costUsd: cost, error: result.error ?? result.summary.slice(0, 300) })
      if (o.budgetUsd - spent < cap) budgetHit = true
      continue
    }
    const files = { ...release, ...result.files }
    for (const p of result.deleted) delete files[p]
    const to = await commit(head, files, `${CARRIED_MESSAGE} by the agent: ${result.summary}`.slice(0, 200), 'agent')
    await record({ userId: h.userId, from: head.id, to, state: to ? 'migrated' : 'moved', costUsd: cost })
  }
  const status: CarryOverResult['status'] = o.dryRun ? 'dry-run' : budgetHit ? 'budget' : 'done'
  if (!o.dryRun) await store.call('POST', `/admin/releases/${runId}/finish`, { status })
  const counts = items.reduce<Record<string, number>>((m, i) => ((m[i.state] = (m[i.state] ?? 0) + 1), m), {})
  return { release: runId, status, spentUsd: Number(spent.toFixed(6)), budgetUsd: o.budgetUsd, items, skipped, counts, perUserUsd: cap, perUserSource: o.perUserUsd === undefined ? 'plan' : 'flag', plan: planName }
}

/** Restore the heads a carry-over run moved (users who edited again since keep their newer version). */
export async function rollbackRelease(o: Pick<CarryOverOptions, 'storeUrl' | 'appId' | 'appKey' | 'fetch'> & { release: string }): Promise<{ restored: string[]; kept: string[] }> {
  const store = new Store(o.storeUrl, o.appId, o.appKey ?? null, o.fetch ?? ((...a) => globalThis.fetch(...a)))
  const want = o.release.trim().toLowerCase()
  const runs = (await store.call<{ release: string }[]>('GET', '/admin/releases')).body
  const match = runs.filter((r) => want.length >= 8 && (r.release.startsWith(want) || want.startsWith(r.release)))
  if (match.length !== 1) throw new Error(match.length ? `--release ${o.release} matches ${match.length} runs; give more characters` : `no carry-over run for release ${o.release}`)
  return (await store.call<{ restored: string[]; kept: string[] }>('POST', `/admin/releases/${match[0]!.release}/rollback`)).body
}
