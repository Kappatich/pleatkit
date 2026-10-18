import type { Alert, AlertSink } from './alerts.js'
import type { ModelProvider } from './types.js'
import { buildWishMap, type WishCluster } from './wishes.js'

/**
 * C5, the weekly digest (`pleatkit digest --week`): what happened in an app over the last week, as markdown for a
 * person: requests and their outcomes, cost, carry-overs, what waits on the admin, whether the audit chain is
 * intact, and the wish-list map (C9) built by one classifier call over the week's unserved requests. Sent through
 * the alert channel of 4b H5 (webhook and/or e-mail API).
 */
export interface DigestOptions {
  storeUrl: string
  appId: string
  appKey?: string | null
  /** Builds the wish map (one classifier call); without it the latest stored map is shown. */
  provider?: ModelProvider | null
  panels?: string[]
  days?: number
  now?: number
  fetch?: typeof fetch
}

type Row = Record<string, string | number>

export interface WishSummary extends WishCluster {
  requests?: number
  users?: number
}

export interface Digest {
  appId: string
  from: string
  to: string
  days: number
  total: Row
  rows: Row[]
  pending: { review: number; admin: number }
  audit: { ok: boolean; rows: number; brokenAt: number | null }
  wishes: { clusters: WishSummary[]; model: string | null; calls: number; built: 'now' | 'stored' | 'none' }
}

export async function buildDigest(o: DigestOptions): Promise<Digest> {
  const f = o.fetch ?? ((...a) => globalThis.fetch(...a))
  const base = o.storeUrl.replace(/\/$/, '').replace(/\/v1$/, '') + '/v1'
  const headers = { 'x-pleatkit-app': o.appId, ...(o.appKey ? { authorization: `Bearer ${o.appKey}` } : { 'x-pleatkit-admin': '1' }) }
  const get = async <T>(path: string): Promise<T> => {
    const res = await f(`${base}${path}`, { headers })
    if (!res.ok) throw new Error(`store-server GET ${path} answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return (await res.json()) as T
  }
  const days = o.days ?? 7
  const to = o.now ?? Date.now()
  const from = to - days * 24 * 60 * 60 * 1000
  const report = await get<{ rows: Row[]; total: Row }>(`/report?format=json&from=${from}&to=${to}`)
  const stats = await get<{ pendingReview: number }>('/admin/stats')
  const waiting = await get<unknown[]>('/admin/requests?status=pending-admin&limit=1000')
  const audit = (await get<{ verify: Digest['audit'] }>('/admin/audit?verify=1&limit=1')).verify
  let wishes: Digest['wishes']
  if (o.provider) {
    const map = await buildWishMap({ provider: o.provider, storeUrl: o.storeUrl, appId: o.appId, appKey: o.appKey ?? null, panels: o.panels ?? [], fromMs: from, toMs: to, fetch: f })
    // counts per theme as /admin shows them
    const stored = await get<{ map: { clusters: WishSummary[] } | null }>('/admin/wishes')
    wishes = { clusters: stored.map?.clusters ?? map.clusters, model: map.model, calls: map.calls, built: 'now' }
  } else {
    const stored = await get<{ map: { clusters: WishSummary[]; model: string | null } | null }>('/admin/wishes')
    wishes = { clusters: stored.map?.clusters ?? [], model: stored.map?.model ?? null, calls: 0, built: stored.map ? 'stored' : 'none' }
  }
  return {
    appId: o.appId,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    days,
    total: report.total,
    rows: report.rows,
    pending: { review: stats.pendingReview, admin: waiting.length },
    audit,
    wishes,
  }
}

const n = (r: Row, k: string) => Number(r[k] ?? 0)
const usd = (v: number) => `$${v.toFixed(4)}`
const cell = (s: string | number) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

export function digestMarkdown(d: Digest): string {
  const t = d.total
  const lines = [
    `# pleatkit weekly digest: ${d.appId}`,
    '',
    `${d.from.slice(0, 10)} to ${d.to.slice(0, 10)} (${d.days} days)`,
    '',
    '| | |',
    '|---|---|',
    `| Requests | ${n(t, 'requests')} from ${n(t, 'users')} users in ${n(t, 'orgs')} organizations |`,
    `| Applied | ${n(t, 'applied')}; live after 24 h ${n(t, 'alive_24h')}, undone by users ${n(t, 'reverted_by_user')}, rolled back by admins ${n(t, 'rolled_back_by_admin')} |`,
    `| Not served | needs backend ${n(t, 'needs_backend') + n(t, 'partial')}, out of zone ${n(t, 'out_of_zone')}, failed ${n(t, 'failed')}, declined or refused ${n(t, 'declined') + n(t, 'refused')} |`,
    `| Carried over to new releases | ${n(t, 'carry_overs')} |`,
    `| Model cost | ${usd(n(t, 'cost_usd'))} |`,
    `| Waiting on you | ${d.pending.review} edits to review, ${d.pending.admin} backend requests |`,
    `| Audit chain | ${d.audit.ok ? `intact (${d.audit.rows} rows)` : `BROKEN at row ${d.audit.brokenAt} of ${d.audit.rows}: see docs/ops/incident.md`} |`,
    '',
    '## Wish map',
    '',
  ]
  if (!d.wishes.clusters.length) lines.push(d.wishes.built === 'none' ? 'No wish map yet.' : 'Nothing the panels could not serve this week.')
  else {
    const byPanel = new Map<string, WishSummary[]>()
    for (const k of d.wishes.clusters) byPanel.set(k.panel, [...(byPanel.get(k.panel) ?? []), k])
    for (const [panel, ks] of [...byPanel].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`### ${panel}`, '')
      for (const k of ks.sort((a, b) => (b.requests ?? b.requestIds.length) - (a.requests ?? a.requestIds.length))) {
        const count = k.requests ?? k.requestIds.length
        lines.push(`- **${k.title}** (${k.kind === 'needs-backend' ? 'needs backend' : 'out of zone'}): ${count} request${count === 1 ? '' : 's'}${k.users !== undefined ? `, ${k.users} user${k.users === 1 ? '' : 's'}` : ''}`)
      }
      lines.push('')
    }
    lines.push(`Built ${d.wishes.built === 'now' ? `now by one classifier call (${d.wishes.model ?? 'no model'})` : 'earlier (the latest stored map)'}.`)
  }
  lines.push('', '## By organization', '', '| Organization | Requests | Users | Applied | Live 24 h | Needs backend | Cost |', '|---|---:|---:|---:|---:|---:|---:|')
  const orgs = new Map<string, Row>()
  for (const r of d.rows) {
    const o: Row = orgs.get(String(r.org)) ?? { org: String(r.org), requests: 0, users: 0, applied: 0, alive_24h: 0, needs_backend: 0, cost_usd: 0 }
    for (const k of ['requests', 'users', 'applied', 'alive_24h', 'needs_backend', 'cost_usd']) o[k] = n(o, k) + n(r, k)
    orgs.set(String(r.org), o)
  }
  if (!orgs.size) lines.push('| (no requests) | 0 | 0 | 0 | 0 | 0 | $0.0000 |')
  for (const o of [...orgs.values()].sort((a, b) => n(b, 'requests') - n(a, 'requests'))) {
    lines.push(`| ${cell(o.org ?? '')} | ${n(o, 'requests')} | ${n(o, 'users')} | ${n(o, 'applied')} | ${n(o, 'alive_24h')} | ${n(o, 'needs_backend')} | ${usd(n(o, 'cost_usd'))} |`)
  }
  lines.push('', '_Users per organization add up per day. The full table: `GET /v1/report?from&to` (CSV)._', '')
  return lines.join('\n')
}

/** Send the digest through the alert channel (webhook and/or e-mail API). Returns how many sinks took it. */
export async function sendDigest(d: Digest, markdown: string, sinks: AlertSink[]): Promise<number> {
  const alert: Alert = {
    kind: 'digest',
    severity: d.audit.ok ? 'info' : 'critical',
    appId: d.appId,
    title: `pleatkit weekly digest: ${d.appId}, ${n(d.total, 'requests')} requests, ${d.pending.review + d.pending.admin} waiting on you`,
    details: { markdown },
    at: new Date().toISOString(),
  }
  let sent = 0
  for (const s of sinks) {
    await s.send(alert)
    sent++
  }
  return sent
}
