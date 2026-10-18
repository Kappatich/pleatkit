import type { TokenUsage } from '@pleatkit/runtime/compiler'
import { costUsd, priceOf } from './pricing.js'
import type { ModelProvider } from './types.js'

/**
 * C9, the wish-list map (brainstorm 12 A2): what users asked for that the dynamic zone cannot serve (needs a
 * backend change, or is outside the zone), grouped into themes per panel by ONE classifier call over the week's
 * digest. No embeddings. The scripted provider answers from a fixture (`wishes` in a fixture file) and the replay
 * provider from a transcript, so the map is built offline in tests and in the demo.
 */
export type WishKind = 'needs-backend' | 'out-of-zone'

export interface WishItem {
  id: string
  /** The panel the user pointed at, when they did. */
  panel: string | null
  kind: WishKind
  /** The request text (tenant data), or its gist after retention. */
  text: string
  userId?: string
  intentLabel?: string | null
}

export interface WishCluster {
  panel: string
  title: string
  kind: WishKind
  requestIds: string[]
}

export interface ClusterInput {
  items: { id: string; panel: string | null; kind: WishKind; text: string }[]
  /** Panel ids of the app (the classifier assigns a request without a panel to one of them, or `other`). */
  panels: string[]
}

export interface ClusterOutput {
  clusters: WishCluster[]
  usage: TokenUsage | null
  model: string | null
}

/**
 * DECISIONS 70.3: one clustering call reads at most `maxItems` requests (the newest of the range) and may cost at
 * most `budgetUsd`, estimated before the call from the prompt's size and the classifier's price with the whole
 * output allowance. Requests over the budget are grouped without the model (fallback themes, free); requests over
 * `maxItems` are not read. Defaults 500 and $0.50; PLEATKIT_WISHES_MAX_ITEMS and PLEATKIT_WISHES_BUDGET_USD, or
 * `pleatkit digest --wishes-max-items --wishes-budget-usd`.
 */
export interface WishLimits {
  maxItems: number
  budgetUsd: number
}
export const DEFAULT_WISH_LIMITS: WishLimits = { maxItems: 500, budgetUsd: 0.5 }
/** Output allowance of the clustering call (`max_tokens`), counted in full by the estimate. */
export const CLUSTER_MAX_TOKENS = 4096

/** The limits from the environment; bad or missing values keep the defaults. */
export function wishLimitsFromEnv(env: Record<string, string | undefined>): WishLimits {
  const n = (v: string | undefined) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined)
  return { maxItems: Math.floor(n(env.PLEATKIT_WISHES_MAX_ITEMS) ?? DEFAULT_WISH_LIMITS.maxItems), budgetUsd: n(env.PLEATKIT_WISHES_BUDGET_USD) ?? DEFAULT_WISH_LIMITS.budgetUsd }
}

/** Version of the clustering instructions (separate from the edit prompt's PROMPT_VERSION). */
export const WISHES_PROMPT_VERSION = '2026-10-18.4c2'

export const WISHES_INSTRUCTIONS = `You group the requests that users of a web app made but that its customizable panels could not serve.
Each request either needs a backend change ("needs-backend") or asks for something outside the customizable panels ("out-of-zone").
Group requests that ask for the same thing into one theme. Rules:
- A theme belongs to one panel: use the request's panel when it has one; otherwise pick the panel from the list the request is about, or "other".
- A theme has one kind: needs-backend or out-of-zone.
- The title says what users want in at most 8 words, in English, without user names, numbers or quotes. Example: "Discounts that change the deal amount".
- Every request id appears in exactly one theme. Do not invent ids.
- Prefer fewer, broader themes; a theme may have one request.
Answer with JSON only: {"clusters": [{"panel": "...", "title": "...", "kind": "needs-backend", "request_ids": ["..."]}]}`

export const CLUSTER_SCHEMA = {
  type: 'object',
  properties: {
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          panel: { type: 'string' },
          title: { type: 'string' },
          kind: { type: 'string', enum: ['needs-backend', 'out-of-zone'] },
          request_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['panel', 'title', 'kind', 'request_ids'],
        additionalProperties: false,
      },
    },
  },
  required: ['clusters'],
  additionalProperties: false,
} as const

/** The user message of the clustering call: the panels, then one line per request. */
export function clusterMessage(input: ClusterInput): string {
  const lines = input.items.map((i) => `${i.id} | ${i.panel ?? '-'} | ${i.kind} | ${i.text.replace(/\s+/g, ' ').slice(0, 300)}`)
  return `<panels>\n${input.panels.join('\n') || '(none)'}\n</panels>\n\n<requests>\nid | panel | kind | request\n${lines.join('\n')}\n</requests>`
}

/** Clusters from a model's JSON answer (`request_ids` or `requestIds`); malformed answers give none. */
export function parseClusters(text: string): WishCluster[] {
  try {
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { clusters?: Record<string, unknown>[] }
    return (parsed.clusters ?? []).map((k) => ({
      panel: typeof k.panel === 'string' ? k.panel : 'other',
      title: typeof k.title === 'string' ? k.title : '',
      kind: k.kind === 'out-of-zone' ? 'out-of-zone' : 'needs-backend',
      requestIds: ((k.request_ids ?? k.requestIds ?? []) as unknown[]).filter((x): x is string => typeof x === 'string'),
    }))
  } catch {
    return []
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/** Without a model: one theme per (panel, kind, intent label), titled by its first request. */
export function fallbackClusters(items: WishItem[]): WishCluster[] {
  const groups = new Map<string, WishCluster>()
  for (const i of items) {
    const panel = i.panel ?? 'other'
    const k = `${panel}\0${i.kind}\0${i.intentLabel ?? ''}`
    let g = groups.get(k)
    if (!g) groups.set(k, (g = { panel, kind: i.kind, title: clip(i.text || 'Other requests', 60), requestIds: [] }))
    g.requestIds.push(i.id)
  }
  return [...groups.values()]
}

/**
 * Keep what the model may decide and nothing else: known ids only, each id in one theme (the first), a kind and a
 * short title; requests the model left out go into fallback themes, so the map always covers every item.
 */
export function normalizeClusters(raw: WishCluster[], items: WishItem[]): WishCluster[] {
  const byId = new Map(items.map((i) => [i.id, i]))
  const seen = new Set<string>()
  const out: WishCluster[] = []
  for (const k of raw) {
    const ids = k.requestIds.filter((id) => byId.has(id) && !seen.has(id))
    if (!ids.length) continue
    ids.forEach((id) => seen.add(id))
    const kinds = ids.map((id) => byId.get(id)!.kind)
    const kind: WishKind = kinds.filter((x) => x === 'out-of-zone').length > kinds.length / 2 ? 'out-of-zone' : 'needs-backend'
    out.push({ panel: clip(k.panel.trim() || 'other', 80), title: clip(k.title.trim() || byId.get(ids[0]!)!.text || 'Other requests', 120), kind, requestIds: ids })
  }
  const rest = items.filter((i) => !seen.has(i.id))
  return [...out, ...fallbackClusters(rest)]
}

export interface WishMap {
  clusters: WishCluster[]
  items: number
  provider: string
  model: string | null
  usage: TokenUsage | null
  /** Model calls made: 1 with a provider that clusters, 0 for an empty digest or the fallback. */
  calls: number
  /** Requests the model grouped; the rest of `items` went into fallback themes because of the budget. */
  clustered: number
  /** The estimate the budget was checked against (null: the model's price is unknown), and the cost after. */
  estimatedUsd: number | null
  costUsd: number | null
  limits: WishLimits
}

const toInput = (items: WishItem[], panels: string[]): ClusterInput => ({ items: items.map(({ id, panel, kind, text }) => ({ id, panel, kind, text })), panels })

/**
 * Upper estimate of one clustering call: about 3 characters per input token (prompt and requests; English text
 * averages nearer 4) and the whole output allowance. Null when the classifier's price is unknown.
 */
export function estimateClusterUsd(model: string | null | undefined, input: ClusterInput): number | null {
  const price = model ? priceOf(model) : null
  if (!price) return null
  const inputTokens = Math.ceil((WISHES_INSTRUCTIONS.length + clusterMessage(input).length) / 3)
  return (inputTokens * price.input + CLUSTER_MAX_TOKENS * price.output) / 1_000_000
}

/**
 * One classifier call over the digest's items (none when there is nothing to group), at most `limits.maxItems`
 * of them (the first, i.e. the newest) and within `limits.budgetUsd` by the estimate: the oldest requests that do
 * not fit go into fallback themes. When not even one fits, no call is made.
 */
export async function clusterWishes(
  provider: ModelProvider,
  allItems: WishItem[],
  panels: string[],
  signal: AbortSignal = AbortSignal.timeout(120_000),
  limits: Partial<WishLimits> = {},
): Promise<WishMap> {
  const lim: WishLimits = { ...DEFAULT_WISH_LIMITS, ...limits }
  const items = allItems.slice(0, lim.maxItems)
  const none = { provider: provider.name, model: null, usage: null, calls: 0, clustered: 0, estimatedUsd: null, costUsd: null, limits: lim }
  if (!items.length) return { ...none, clusters: [], items: 0 }
  if (!provider.cluster) return { ...none, clusters: fallbackClusters(items), items: items.length }
  // the largest newest-first prefix whose estimate fits the budget (binary search: the estimate grows with n)
  const estimate = (n: number) => estimateClusterUsd(provider.clusterModel, toInput(items.slice(0, n), panels))
  let n = items.length
  if ((estimate(n) ?? 0) > lim.budgetUsd) {
    let lo = 0
    let hi = n
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if ((estimate(mid) ?? 0) <= lim.budgetUsd) lo = mid
      else hi = mid - 1
    }
    n = lo
  }
  if (n === 0) return { ...none, clusters: fallbackClusters(items), items: items.length, estimatedUsd: estimate(1) }
  const sent = items.slice(0, n)
  const out = await provider.cluster(toInput(sent, panels), signal)
  return {
    // the model's themes over what it read; normalizeClusters puts everything else into fallback themes
    clusters: normalizeClusters(out.clusters, items),
    items: items.length,
    provider: provider.name,
    model: out.model,
    usage: out.usage,
    calls: 1,
    clustered: n,
    estimatedUsd: estimate(n),
    costUsd: out.model && out.usage ? costUsd(out.model, out.usage) : null,
    limits: lim,
  }
}

export interface BuildWishMapOptions {
  provider: ModelProvider
  /** store-server base URL and the app; the app key (or, in development, the admin header) reads and writes. */
  storeUrl: string
  appId: string
  appKey?: string | null
  /** Panel ids of the app (from its manifest); optional. */
  panels?: string[]
  fromMs?: number
  toMs?: number
  fetch?: typeof fetch
  /** Store the map in store-server for /admin's Wishes screen. Default true. */
  save?: boolean
  /** DECISIONS 70.3: at most this many requests, within this budget (defaults 500 and $0.50). */
  limits?: Partial<WishLimits>
}

/** Read the range's wish items from store-server, cluster them with one call, store the map. */
export async function buildWishMap(o: BuildWishMapOptions): Promise<WishMap & { from: number; to: number; total: number }> {
  const f = o.fetch ?? ((...a) => globalThis.fetch(...a))
  const base = o.storeUrl.replace(/\/$/, '').replace(/\/v1$/, '') + '/v1'
  const headers = { 'content-type': 'application/json', 'x-pleatkit-app': o.appId, ...(o.appKey ? { authorization: `Bearer ${o.appKey}` } : { 'x-pleatkit-admin': '1' }) }
  const to = o.toMs ?? Date.now() + 1 // exclusive: this millisecond's requests count
  const from = o.fromMs ?? to - 7 * 24 * 60 * 60 * 1000
  const limits: WishLimits = { ...DEFAULT_WISH_LIMITS, ...o.limits }
  const res = await f(`${base}/admin/wish-items?from=${from}&to=${to}&limit=${limits.maxItems}`, { headers })
  if (!res.ok) throw new Error(`store-server wish-items answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const { items, total } = (await res.json()) as { items: WishItem[]; total?: number }
  const map = await clusterWishes(o.provider, items, o.panels ?? [], undefined, limits)
  if (o.save !== false) {
    const put = await f(`${base}/admin/wishes`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ from, to, provider: map.provider, model: map.model, items: map.items, clusters: map.clusters }),
    })
    if (!put.ok) throw new Error(`store-server wishes answered ${put.status}: ${(await put.text()).slice(0, 200)}`)
  }
  return { ...map, from, to, total: total ?? items.length }
}
