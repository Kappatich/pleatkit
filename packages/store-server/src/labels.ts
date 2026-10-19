import { and, desc, eq, gte, sql, type SQL } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { Caller } from './auth.js'
import type { StoreDb, StoreEnv } from './extension.js'
import { requestLabels, requests } from './schema.js'

/**
 * DECISIONS 81: people label logged requests on the /admin Labels screen; the labels where a person disagrees with
 * the classifier go straight into the `eval:classify` probes (`pleatkit labels export`).
 */
export const LABELS = ['ui', 'needs-backend', 'clarify', 'off-topic', 'declined', 'mixed', 'restore'] as const
export type RequestLabel = (typeof LABELS)[number]
export const isLabel = (v: unknown): v is RequestLabel => typeof v === 'string' && (LABELS as readonly string[]).includes(v)

/** `GET /admin/labels?filter=`: what is still to label by the caller, everything, or the caller's disagreements. */
export const LABEL_FILTERS = ['unlabelled', 'all', 'disagreements'] as const
export type LabelFilter = (typeof LABEL_FILTERS)[number]

/**
 * The classifier's suggestion, derived from what the request log already has:
 * - the verdict `restore` (DECISIONS 82.2: the drawer answered with the version history): `restore`, with or without a
 *   `classification`;
 * - no `classification` (the classifier did not run: a pointed panel, a clarification answer, `--no-classifier`): none;
 * - `intent_label` `adversarial`: `declined` (the classifier's intent wins over its label, as `eval:classify` scores it);
 * - `ui` with the verdict `partial` (the agent did the screen part and passed the rest on): `mixed`, otherwise `ui`;
 * - `needs-backend` → `needs-backend`, `unclear` → `clarify`, `off-topic` → `off-topic`, `restore` → `restore`
 *   (DECISIONS 84.2: the seventh button);
 * - any other label: none, until it has a button.
 * `suggestionSql` below is the same mapping in SQL (for the disagreements filter and its count); keep them in step.
 */
const BY_CLASS: Record<string, RequestLabel> = { ui: 'ui', 'needs-backend': 'needs-backend', unclear: 'clarify', 'off-topic': 'off-topic', restore: 'restore' }

export function suggestedLabel(r: { classification: string | null; intentLabel: string | null; verdict: string }): RequestLabel | null {
  if (r.verdict === 'restore') return 'restore'
  if (!r.classification) return null
  if (r.intentLabel === 'adversarial') return 'declined'
  if (r.classification === 'ui' && r.verdict === 'partial') return 'mixed'
  return BY_CLASS[r.classification] ?? null
}

const suggestionSql: SQL = sql`(CASE
  WHEN ${requests.verdict} = 'restore' THEN 'restore'
  WHEN ${requests.classification} IS NULL THEN NULL
  WHEN ${requests.intentLabel} = 'adversarial' THEN 'declined'
  WHEN ${requests.classification} = 'ui' AND ${requests.verdict} = 'partial' THEN 'mixed'
  ${sql.join(
    Object.entries(BY_CLASS).map(([k, v]) => sql`WHEN ${requests.classification} = ${k} THEN ${v}`),
    sql` `,
  )}
  ELSE NULL END)`

/** Who labels: the person behind the call (the admin acting as a user is still the admin), `admin` for the app key. */
export const labelerOf = (who: Caller): string => who.viewer ?? who.userId ?? 'admin'

const PAGE_DEFAULT = 20
const PAGE_MAX = 200
const RECENT = 8
const DAY_MS = 86_400_000

/** A request on the Labels screen; `label` is the caller's own. */
export interface LabelItem {
  id: string
  userId: string
  text: string
  target: string | null
  createdAt: string
  createdAtMs: number
  verdict: string
  status: string
  classification: string | null
  intentLabel: string | null
  suggested: RequestLabel | null
  label: RequestLabel | null
  labeledAt: string | null
}

/** A label for the export (`pleatkit labels export`): every labeller's, with the request it labels. */
export interface LabelExportItem {
  requestId: string
  request: string
  target: string | null
  label: RequestLabel
  suggested: RequestLabel | null
  classification: string | null
  intentLabel: string | null
  verdict: string
  labeledBy: string
  labeledAt: string
}

/**
 * The Labels routes, behind the core's auth and its `/admin/*` rule (admin writes, support reads):
 * - `GET  /admin/labels?filter=unlabelled|all|disagreements&limit=&cursor=&since=` newest first, paged by `cursor`
 *   (the `next` of the previous page), with the caller's counts (labelled since `since` in ms, default today 00:00 UTC;
 *   left to label; disagreements) and the caller's latest labels (`recent`);
 * - `POST /admin/labels` `{ requestId, label }` stores the caller's label (a re-tap replaces it; `label: null` removes it);
 * - `GET  /admin/labels/export?filter=disagreements|all` every labeller's labels with the request text.
 */
export function labelRoutes(api: Hono<StoreEnv>, db: StoreDb): void {
  const caller = (c: Context<StoreEnv>): Caller => c.get('caller')
  /** The caller's label of each request, joined on (app, request, labeller). */
  const mine = (appId: string, labeler: string) =>
    and(eq(requestLabels.appId, appId), eq(requestLabels.requestId, requests.id), eq(requestLabels.labeler, labeler))
  // requests whose text retention has blanked have nothing left to label
  const labellable = (appId: string) => and(eq(requests.appId, appId), sql`${requests.text} <> ''`)
  const rowid = sql<number>`"requests"."rowid"`
  const disagreement = sql`(${requestLabels.label} IS NOT NULL AND ${suggestionSql} IS NOT NULL AND ${requestLabels.label} <> ${suggestionSql})`

  const counts = (appId: string, labeler: string, sinceMs: number) => {
    const total = db.select({ n: sql<number>`count(*)` }).from(requests).where(labellable(appId)).get()?.n ?? 0
    const row = db
      .select({
        labelled: sql<number>`count(*)`,
        today: sql<number>`sum(CASE WHEN ${requestLabels.updatedAtMs} >= ${sinceMs} THEN 1 ELSE 0 END)`,
        disagreements: sql<number>`sum(CASE WHEN ${disagreement} THEN 1 ELSE 0 END)`,
      })
      .from(requests)
      .innerJoin(requestLabels, mine(appId, labeler))
      .where(labellable(appId))
      .get()
    const labelled = Number(row?.labelled ?? 0)
    return { total: Number(total), labelled, left: Number(total) - labelled, today: Number(row?.today ?? 0), disagreements: Number(row?.disagreements ?? 0) }
  }

  /** The caller's latest labels, newest first (the list under the card). */
  const recent = (appId: string, labeler: string, limit = RECENT) =>
    db
      .select({ r: requests, l: requestLabels })
      .from(requestLabels)
      .innerJoin(requests, and(eq(requests.appId, requestLabels.appId), eq(requests.id, requestLabels.requestId)))
      .where(and(eq(requestLabels.appId, appId), eq(requestLabels.labeler, labeler), sql`${requests.text} <> ''`))
      .orderBy(desc(requestLabels.updatedAtMs), desc(requestLabels.requestId))
      .limit(limit)
      .all()
      .map(({ r, l }) => toItem(r, l))

  const toItem = (r: typeof requests.$inferSelect, l: typeof requestLabels.$inferSelect | null): LabelItem => ({
    id: r.id,
    userId: r.userId,
    text: r.text,
    target: r.target,
    createdAt: r.createdAt,
    createdAtMs: r.createdAtMs,
    verdict: r.verdict,
    status: r.status,
    classification: r.classification,
    intentLabel: r.intentLabel,
    suggested: suggestedLabel(r),
    label: l && isLabel(l.label) ? l.label : null,
    labeledAt: l?.updatedAt ?? null,
  })

  const sinceOf = (q: string | undefined) => {
    const n = Number(q)
    return q !== undefined && Number.isFinite(n) && n >= 0 ? n : Math.floor(Date.now() / DAY_MS) * DAY_MS
  }

  api.get('/admin/labels', (c) => {
    const who = caller(c)
    const labeler = labelerOf(who)
    const filter = (c.req.query('filter') ?? 'unlabelled') as LabelFilter
    if (!LABEL_FILTERS.includes(filter)) return c.json({ error: `filter must be one of ${LABEL_FILTERS.join(', ')}` }, 400)
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? PAGE_DEFAULT) || PAGE_DEFAULT, 1), PAGE_MAX)
    // cursor `<createdAtMs>:<rowid>` of the last item of the previous page: newest first, ties in insert order
    const m = /^(\d{1,15}):(\d{1,15})$/.exec(c.req.query('cursor') ?? '')
    const after = m ? sql`(${requests.createdAtMs} < ${Number(m[1])} OR (${requests.createdAtMs} = ${Number(m[1])} AND ${rowid} < ${Number(m[2])}))` : undefined
    const which = filter === 'unlabelled' ? sql`${requestLabels.label} IS NULL` : filter === 'disagreements' ? disagreement : undefined
    const rows = db
      .select({ r: requests, l: requestLabels, rowid })
      .from(requests)
      .leftJoin(requestLabels, mine(who.appId, labeler))
      .where(and(labellable(who.appId), after, which))
      .orderBy(desc(requests.createdAtMs), desc(rowid))
      .limit(limit + 1)
      .all()
    const page = rows.slice(0, limit).map(({ r, l }) => toItem(r, l))
    const last = rows[limit - 1]
    return c.json({
      filter,
      labeler,
      items: page,
      next: rows.length > limit && last ? `${last.r.createdAtMs}:${last.rowid}` : null,
      counts: counts(who.appId, labeler, sinceOf(c.req.query('since'))),
      recent: recent(who.appId, labeler),
    })
  })

  api.post('/admin/labels', async (c) => {
    const who = caller(c)
    const labeler = labelerOf(who)
    const b = await c.req.json<{ requestId?: unknown; label?: unknown; since?: unknown }>().catch(() => ({}) as { requestId?: unknown; label?: unknown; since?: unknown })
    if (typeof b.requestId !== 'string' || !b.requestId) return c.json({ error: 'requestId is required' }, 400)
    if (b.label !== null && !isLabel(b.label)) return c.json({ error: `label must be one of ${LABELS.join(', ')} (or null to remove it)` }, 400)
    const req = db.select().from(requests).where(and(eq(requests.appId, who.appId), eq(requests.id, b.requestId))).get()
    if (!req) return c.json({ error: 'not found' }, 404)
    const key = and(eq(requestLabels.appId, who.appId), eq(requestLabels.requestId, req.id), eq(requestLabels.labeler, labeler))
    if (b.label === null) db.delete(requestLabels).where(key).run()
    else {
      const t = new Date()
      const set = { label: b.label, updatedAt: t.toISOString(), updatedAtMs: t.getTime() }
      db.insert(requestLabels)
        .values({ appId: who.appId, requestId: req.id, labeler, createdAt: t.toISOString(), ...set })
        .onConflictDoUpdate({ target: [requestLabels.appId, requestLabels.requestId, requestLabels.labeler], set })
        .run()
    }
    const l = db.select().from(requestLabels).where(key).get() ?? null
    const item = toItem(req, l)
    return c.json({
      item,
      disagreement: Boolean(item.label && item.suggested && item.label !== item.suggested),
      counts: counts(who.appId, labeler, sinceOf(typeof b.since === 'number' ? String(b.since) : undefined)),
      recent: recent(who.appId, labeler),
    })
  })

  api.get('/admin/labels/export', (c) => {
    const who = caller(c)
    const filter = c.req.query('filter') ?? 'disagreements'
    if (filter !== 'disagreements' && filter !== 'all') return c.json({ error: 'filter must be disagreements or all' }, 400)
    const sinceMs = Number(c.req.query('sinceMs') ?? 0) || 0
    const rows = db
      .select({ r: requests, l: requestLabels })
      .from(requestLabels)
      .innerJoin(requests, and(eq(requests.appId, requestLabels.appId), eq(requests.id, requestLabels.requestId)))
      .where(and(eq(requestLabels.appId, who.appId), sql`${requests.text} <> ''`, gte(requestLabels.updatedAtMs, sinceMs), filter === 'disagreements' ? disagreement : undefined))
      .orderBy(requests.createdAtMs, requests.id, requestLabels.labeler)
      .all()
    const items: LabelExportItem[] = rows
      .filter(({ l }) => isLabel(l.label))
      .map(({ r, l }) => ({
        requestId: r.id,
        request: r.text,
        target: r.target,
        label: l.label as RequestLabel,
        suggested: suggestedLabel(r),
        classification: r.classification,
        intentLabel: r.intentLabel,
        verdict: r.verdict,
        labeledBy: l.labeler,
        labeledAt: l.updatedAt,
      }))
    return c.json({ appId: who.appId, filter, items })
  })
}
