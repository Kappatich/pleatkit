import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { diffLines } from 'diff'
import type { Locale, Moderation, Snapshot, ToolLogEntry, UsageByModel } from '@pleatkit/runtime'
import type { UiKey } from '@pleatkit/ui'
import { adminTranslator, type AdminTranslate } from './admin-i18n'
import { AUTH, STORE_URL, tokenFor } from './pleatkit'
import './admin.css'

interface RequestRow {
  id: string
  userId: string
  text: string
  target: string | null
  verdict: 'ok' | 'needs-backend' | 'failed' | 'clarify'
  summary: string
  status: string
  classification: string | null
  provider: string | null
  model: string | null
  usage: UsageByModel[] | null
  timings: { totalMs?: number } | null
  snapshotId: string | null
  error: string | null
  attachments: { images: number; imageBytes: number; targetDomChars: number } | null
  createdAt: string
  toolCalls: number
  isHead: boolean
}

interface Detail {
  request: RequestRow & { log: ToolLogEntry[]; files: Record<string, string> | null }
  snapshot: Snapshot | null
  parent: Snapshot | null
}

interface Stats {
  total: number
  editsThisWeek: number
  successRate: number | null
  needsBackendRate: number | null
  pendingReview: number
  moderation: Moderation
  byStatus: Record<string, number>
}

function useAdminApi(appId: string) {
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      // `?auth=token`: an admin token from the demo's backend; otherwise the development header
      const auth: Record<string, string> = AUTH === 'token' ? { authorization: `Bearer ${await tokenFor('admin', 'admin')}` } : { 'x-pleatkit-admin': '1' }
      const res = await fetch(`${STORE_URL}/v1${path}`, {
        ...init,
        headers: { ...auth, 'x-pleatkit-app': appId, 'content-type': 'application/json', ...init?.headers },
      })
      const body = (await res.json().catch(() => ({}))) as T & { error?: string }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      return body
    },
    [appId],
  )
}

const cost = (u: UsageByModel[] | null) => (u ?? []).reduce((s, x) => s + (x.costUsd ?? 0), 0)
/** The scripted provider costs nothing and is not a price: show a dash (brainstorm 14 §5.2). */
const costLabel = (r: RequestRow) => (r.provider === 'scripted' || !r.usage?.length ? '—' : `$${cost(r.usage).toFixed(4)}`)

/** One Outcome column instead of Verdict + Status (brainstorm 14 §5.2): the status says it, a mark classifies it. */
const OUTCOME_MARK: Record<string, { mark: string; tone: 'ok' | 'pending' | 'bad' | 'quiet' }> = {
  applied: { mark: '✓', tone: 'ok' },
  'pending-review': { mark: '▸', tone: 'pending' },
  'pending-admin': { mark: '▸', tone: 'pending' },
  'in-progress': { mark: '▸', tone: 'quiet' },
  proposed: { mark: '·', tone: 'quiet' },
  clarifying: { mark: '?', tone: 'quiet' },
  'rolled-back': { mark: '↶', tone: 'quiet' },
  rejected: { mark: '×', tone: 'bad' },
  failed: { mark: '×', tone: 'bad' },
  refused: { mark: '–', tone: 'quiet' },
}
const outcomeOf = (status: string) => OUTCOME_MARK[status] ?? { mark: '·', tone: 'quiet' as const }

/** Renders a "{n} label" string with the number wrapped (mono, tabular) and tagged for tests. */
function counted(text: string, n: number, testId: string): ReactNode {
  const [before, after] = text.split('{n}')
  return (
    <>
      {before}
      <b className="adm-num" data-testid={testId}>
        {n}
      </b>
      {after}
    </>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={open ? 'adm-chev adm-chev-open' : 'adm-chev'} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  )
}

/** /admin: every agent request of the app, what happened to it, and the admin's levers. Design v3 (docs/DESIGN.md). */
export function Admin({ appId, locale = 'en' }: { appId: string; locale?: Locale }) {
  const tr = useMemo(() => adminTranslator(locale), [locale])
  const call = useAdminApi(appId)
  const [rows, setRows] = useState<RequestRow[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [onlyReview, setOnlyReview] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([call<RequestRow[]>('/admin/requests'), call<Stats>('/admin/stats')])
      setRows(r)
      setStats(s)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [call])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [load])

  const setModeration = async (moderation: Moderation) => {
    try {
      await call('/admin/settings', { method: 'PUT', body: JSON.stringify({ moderation }) })
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const appQuery = appId !== 'demo-crm' ? `app=${encodeURIComponent(appId)}` : ''
  const langQuery = locale !== 'en' ? `lang=${locale}` : ''
  const query = [appQuery, langQuery].filter(Boolean).join('&')

  const pendingReview = stats?.pendingReview ?? 0
  const filtering = onlyReview && pendingReview > 0
  const shown = filtering ? rows.filter((r) => r.status === 'pending-review') : rows
  const reviewOn = stats?.moderation === 'review'
  const total = stats?.total ?? 0
  const needsBackend = Math.round((stats?.needsBackendRate ?? 0) * total)

  return (
    <div className="adm" lang={locale}>
      <header className="adm-top">
        <div className="adm-brand">
          <span className="adm-app">Acme CRM</span>
          <span className="adm-dot" aria-hidden="true" />
          <span className="adm-sub">
            {tr('admin.title')} · <span className="adm-mono">{appId}</span>
          </span>
        </div>
        <div className="adm-settings" data-testid="admin-moderation" aria-label={tr('adm.settings')}>
          <span className="adm-settings-label">{tr('adm.settings')}</span>
          <label className="adm-check" title={tr('admin.moderation.hint')}>
            <input
              type="checkbox"
              data-testid="admin-moderation-toggle"
              checked={reviewOn}
              disabled={!stats}
              onChange={(e) => void setModeration(e.target.checked ? 'review' : 'off')}
            />
            <span>{tr('admin.moderation')}</span>
          </label>
          <a className="adm-back" href={`/${query ? `?${query}` : ''}`}>
            {tr('admin.back')}
          </a>
        </div>
      </header>

      <main className="adm-main" data-testid="admin">
        <h1 className="adm-h1">{tr('admin.requests')}</h1>

        <div className="adm-stats" data-testid="admin-stats">
          <p className="adm-week">
            {tr('adm.week')} {counted(tr(total === 1 ? 'adm.week.requests.one' : 'adm.week.requests'), total, 'stat-total')}
            <span className="adm-sep"> · </span>
            {counted(tr('adm.week.applied'), stats?.editsThisWeek ?? 0, 'stat-edits')}
            <span className="adm-sep"> · </span>
            {counted(tr('adm.week.backend'), needsBackend, 'stat-backend')}
          </p>
          <div className="adm-chips">
            {pendingReview > 0 && (
              <button
                type="button"
                className="adm-chip adm-chip-red"
                data-testid="admin-filter-review"
                aria-pressed={filtering}
                title={tr(filtering ? 'adm.filter.all.tip' : 'adm.filter.review.tip')}
                onClick={() => setOnlyReview((v) => !v)}
              >
                {tr('adm.filter.review')}{' '}
                <b className="adm-num" data-testid="stat-review">
                  {pendingReview}
                </b>
                {filtering && <span aria-hidden="true"> ×</span>}
              </button>
            )}
            <span className="adm-chip" data-testid="admin-review-chip" title={tr('adm.reviewChip.tip')}>
              {tr('adm.reviewChip', { state: tr(reviewOn ? 'adm.on' : 'adm.off') })}
            </span>
          </div>
        </div>

        {error && <p className="adm-error">Store-server: {error}</p>}

        <table className="adm-table" data-testid="admin-requests">
          <colgroup>
            <col className="adm-c-time" />
            <col className="adm-c-user" />
            <col />
            <col className="adm-c-outcome" />
            <col className="adm-c-cost" />
            <col className="adm-c-chev" />
          </colgroup>
          <thead>
            <tr>
              <th>{tr('adm.col.time')}</th>
              <th>{tr('admin.col.user')}</th>
              <th>{tr('admin.col.request')}</th>
              <th>{tr('adm.col.outcome')}</th>
              <th className="adm-r">{tr('admin.col.cost')}</th>
              <th aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="adm-empty">
                  {tr('admin.empty')}
                </td>
              </tr>
            )}
            {shown.map((r) => {
              const o = outcomeOf(r.status)
              const isOpen = open === r.id
              const at = new Date(r.createdAt)
              return (
                <Fragment key={r.id}>
                  <tr
                    className={`adm-row adm-t-${o.tone}${isOpen ? ' adm-open' : ''}`}
                    onClick={() => setOpen(isOpen ? null : r.id)}
                    data-testid="admin-row"
                    data-request-id={r.id}
                    data-status={r.status}
                    data-verdict={r.verdict}
                  >
                    <td className="adm-time">
                      <span className="adm-hm">{at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</span>
                      <span className="adm-date">{at.toLocaleDateString(locale, { day: '2-digit', month: 'short' })}</span>
                    </td>
                    <td className="adm-user">{r.userId}</td>
                    <td className="adm-req">
                      <span className="adm-text">{r.text}</span>
                      <span className="adm-summary">{r.summary}</span>
                    </td>
                    <td className="adm-outcome" data-testid="admin-status">
                      <span className="adm-mark" aria-hidden="true">
                        {o.mark}
                      </span>
                      <span className="adm-otext">{tr(`status.${r.status}` as UiKey)}</span>
                      {r.isHead && <span className="adm-live">{tr('admin.live')}</span>}
                    </td>
                    <td className="adm-cost">{costLabel(r)}</td>
                    <td className="adm-chevcell">
                      <button type="button" className="adm-disclose" aria-expanded={isOpen} aria-label={tr('adm.open')}>
                        <Chevron open={isOpen} />
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="adm-detailrow">
                      <td colSpan={6}>
                        <RequestDetail id={r.id} call={call} tr={tr} onChanged={load} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </main>
    </div>
  )
}

function RequestDetail({ id, call, tr, onChanged }: { id: string; call: ReturnType<typeof useAdminApi>; tr: AdminTranslate; onChanged: () => Promise<void> }) {
  const [d, setD] = useState<Detail | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(() => call<Detail>(`/admin/requests/${id}`).then(setD), [call, id])
  useEffect(() => {
    void load()
  }, [load])

  const act = async (action: 'rollback' | 'reject' | 'approve', done: string) => {
    try {
      await call(`/admin/requests/${id}/${action}`, { method: 'POST', body: '{}' })
      setMsg(done)
      await Promise.all([load(), onChanged()])
    } catch (e) {
      setMsg((e as Error).message)
    }
  }

  if (!d) return <p className="adm-loading">{tr('admin.loading')}</p>
  const r = d.request
  const after = d.snapshot?.files ?? r.files ?? {}
  const before = d.parent?.files ?? {}
  const changed = Object.keys({ ...before, ...after })
    .filter((p) => before[p] !== after[p] && (d.snapshot ? true : p in after))
    .sort()
  const diffs = changed.map((p) => ({ path: p, hunks: fragments(before[p] ?? '', after[p] ?? '') }))
  const lines = diffs.flatMap((f) => f.hunks).filter((h): h is DLine => !('gap' in h))
  const added = lines.filter((l) => l.kind === '+').length
  const removed = lines.filter((l) => l.kind === '-').length

  return (
    <div className="adm-detail" data-testid="admin-detail">
      {/* 1. summary */}
      <section className="adm-d-sum">
        {changed.length > 0 && (
          <p className="adm-d-summary" data-testid="admin-change-summary">
            {tr(changed.length === 1 ? 'adm.changed.one' : 'adm.changed', { n: changed.length })}
            <span className="adm-sep"> · </span>
            <span className="adm-plus">+{added}</span> <span className="adm-minus">−{removed}</span>
          </p>
        )}
        {r.attachments && (r.attachments.images > 0 || r.attachments.targetDomChars > 0) && (
          <p className="adm-d-note" data-testid="admin-attachments">
            {tr('admin.attachments', { images: r.attachments.images, kb: Math.round(r.attachments.imageBytes / 1024), dom: r.attachments.targetDomChars })}
          </p>
        )}
        {r.error && <p className="adm-d-error">{tr(r.verdict === 'failed' && !r.snapshotId ? 'admin.agentError' : 'admin.browserError', { error: r.error })}</p>}
      </section>

      {/* 2. diff of the changed fragments only */}
      <section className="adm-d-diff">
        <h4 className="adm-h4">
          {tr('admin.changes')} {d.snapshot ? tr('admin.changes.vsParent') : tr('admin.changes.proposed')}
        </h4>
        {changed.length === 0 && <p className="adm-d-note">{tr('admin.changes.none')}</p>}
        {diffs.map((f) => (
          <FileDiff key={f.path} path={f.path} hunks={f.hunks} tr={tr} />
        ))}
      </section>

      {/* 3. actions */}
      <div className="adm-actions">
        {r.status === 'pending-review' && (
          <button type="button" className="adm-btn adm-btn-main" data-testid="admin-approve" title={tr('adm.approve.tip')} onClick={() => void act('approve', tr('admin.done.approve'))}>
            {tr('admin.approve')}
          </button>
        )}
        {r.status === 'pending-admin' && (
          <button type="button" className="adm-btn adm-btn-main" data-testid="admin-approve" title={tr('adm.take.tip')} onClick={() => void act('approve', tr('admin.done.take'))}>
            {tr('admin.take')}
          </button>
        )}
        {r.isHead && (
          <button type="button" className="adm-btn" data-testid="admin-rollback" title={tr('adm.undoFor.tip', { user: r.userId })} onClick={() => void act('rollback', tr('admin.done.rollback'))}>
            {tr('adm.undoFor', { user: r.userId })}
          </button>
        )}
        {r.status !== 'rejected' && r.status !== 'rolled-back' && (
          <button type="button" className="adm-btn adm-btn-quiet" data-testid="admin-reject" title={tr('adm.reject.tip')} onClick={() => void act('reject', tr('admin.done.reject'))}>
            {tr('admin.reject')}
          </button>
        )}
        {msg && (
          <span className="adm-msg" data-testid="admin-msg">
            {msg}
          </span>
        )}
      </div>

      {/* 4. debug, the tool log and file contents, for whoever needs them */}
      <details className="adm-tech">
        <summary>{tr('adm.tech')}</summary>
        <p className="adm-tech-meta">
          {r.provider}/{r.model} · classified {r.classification ?? '—'} · {r.timings?.totalMs ?? '—'} ms · {tr('adm.toolCalls', { n: r.log.length })}
          {r.usage?.map((u) => ` · ${u.model}: ${u.inputTokens} in / ${u.outputTokens} out${u.thinkingTokens ? ` (${u.thinkingTokens} thinking)` : ''} / ${u.cacheReadTokens} cached`).join('')}
        </p>
        <h4 className="adm-h4">{tr('admin.log')}</h4>
        <table className="adm-log" data-testid="admin-log">
          <thead>
            <tr>
              <th>#</th>
              <th>{tr('admin.log.tool')}</th>
              <th>{tr('admin.log.input')}</th>
              <th>{tr('admin.log.result')}</th>
              <th className="adm-r">ms</th>
            </tr>
          </thead>
          <tbody>
            {r.log.map((l, i) => (
              <tr key={i} className={l.ok ? undefined : 'adm-bad'} data-testid="admin-log-row" data-tool={l.tool} data-ok={l.ok}>
                <td>{l.turn}</td>
                <td>{l.tool}</td>
                <td className="adm-log-in">{JSON.stringify(l.input)}</td>
                <td className="adm-log-out">
                  {l.violation && <strong>violation: </strong>}
                  {l.result.length > 400 ? l.result.slice(0, 400) + '…' : l.result}
                </td>
                <td className="adm-r">{l.ms}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {changed.some((p) => p in after) && (
          <>
            <h4 className="adm-h4">{tr('adm.files')}</h4>
            {changed
              .filter((p) => p in after)
              .map((p) => (
                <div key={p} className="adm-file">
                  <div className="adm-path">{p}</div>
                  <pre>{after[p]}</pre>
                </div>
              ))}
          </>
        )}
      </details>
    </div>
  )
}

type DLine = { kind: '+' | '-' | ' '; text: string; n: number }
type Hunk = DLine | { gap: number }

/** The changed fragments of a file with `context` lines around each, and the rest folded into gaps. */
function fragments(before: string, after: string, context = 2): Hunk[] {
  const lines: DLine[] = []
  let a = 1
  let b = 1
  for (const part of diffLines(before, after)) {
    for (const text of part.value.replace(/\n$/, '').split('\n')) {
      if (part.added) lines.push({ kind: '+', text, n: b++ })
      else if (part.removed) lines.push({ kind: '-', text, n: a++ })
      else {
        lines.push({ kind: ' ', text, n: b++ })
        a++
      }
    }
  }
  const keep = lines.map(() => false)
  lines.forEach((l, i) => {
    if (l.kind === ' ') return
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true
  })
  const out: Hunk[] = []
  let run: DLine[] = []
  const flush = () => {
    if (run.length >= 3) out.push({ gap: run.length })
    else out.push(...run)
    run = []
  }
  lines.forEach((l, i) => {
    if (keep[i]) {
      flush()
      out.push(l)
    } else run.push(l)
  })
  flush()
  return out
}

function FileDiff({ path, hunks, tr }: { path: string; hunks: Hunk[]; tr: AdminTranslate }) {
  return (
    <div className="adm-diff" data-testid="admin-diff" data-file={path}>
      <div className="adm-path">{path}</div>
      <pre>
        {hunks.map((h, i) =>
          'gap' in h ? (
            <div key={i} className="adm-gap">
              ⋯ {tr('adm.unchanged', { n: h.gap })}
            </div>
          ) : (
            <div key={i} className={h.kind === '+' ? 'adm-add' : h.kind === '-' ? 'adm-del' : undefined}>
              <span className="adm-ln" aria-hidden="true">
                {h.n}
              </span>
              {h.kind === ' ' ? '  ' : `${h.kind} `}
              {h.text}
            </div>
          ),
        )}
      </pre>
    </div>
  )
}
