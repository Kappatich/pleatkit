import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Locale } from '@pleatkit/runtime'
import type { AdminCall } from './admin-api'
import type { AdminTranslate } from './admin-i18n'

/**
 * The /admin screens beyond the request log (stage 4c block 2): the wish-list map (C9), code search and rollback
 * by selection (C11), carry-over runs per release (C10), and the 4a foundations that had no screen yet: flags,
 * the events feed, the audit chain and the plan with its usage. Same design v3 as the requests: one H1, one stats
 * line between rules, timetables with mono column labels, red only for what waits on the admin.
 */
interface ScreenProps {
  call: AdminCall
  tr: AdminTranslate
  locale: Locale
}

type K = Parameters<AdminTranslate>[0]

const hm = (iso: string, locale: Locale) => new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const day = (iso: string, locale: Locale) => new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: 'short' })

export function TimeCell({ iso, locale, className }: { iso: string | null; locale: Locale; className?: string }) {
  const cls = className ? `adm-time ${className}` : 'adm-time'
  if (!iso) return <td className={cls}>—</td>
  return (
    <td className={cls}>
      <span className="adm-hm">{hm(iso, locale)}</span>
      <span className="adm-date">{day(iso, locale)}</span>
    </td>
  )
}

function Head({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <>
      <h1 className="adm-h1">{title}</h1>
      <div className="adm-stats">{children}</div>
    </>
  )
}

function Problem({ text }: { text: string | null }) {
  return text ? <p className="adm-error">Store-server: {text}</p> : null
}

const usd = (v: number) => `$${v.toFixed(v >= 1 ? 2 : 4)}`

// --- C9: wishes ---

interface WishView {
  panel: string
  title: string
  kind: 'needs-backend' | 'out-of-zone'
  requestIds: string[]
  requests: number
  users: number
  lastAt: string | null
  examples: string[]
}
interface WishMapView {
  createdAt: string
  from: number
  to: number
  provider: string | null
  model: string | null
  items: number
  clusters: WishView[]
}

export function WishesScreen({ call, agent, tr, locale }: ScreenProps & { agent: AdminCall }) {
  const [map, setMap] = useState<WishMapView | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => call<{ map: WishMapView | null }>('/admin/wishes').then((r) => setMap(r.map), (e: Error) => setError(e.message)), [call])
  useEffect(() => void load(), [load])
  const rebuild = async () => {
    setBusy(true)
    try {
      await agent('/wishes', { method: 'POST' })
      setError(null)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const groups = useMemo(() => {
    const by = new Map<string, WishView[]>()
    for (const k of map?.clusters ?? []) by.set(k.panel, [...(by.get(k.panel) ?? []), k])
    const total = (ks: WishView[]) => ks.reduce((n, k) => n + k.requests, 0)
    return [...by.entries()].map(([panel, ks]) => [panel, ks.sort((a, b) => b.requests - a.requests)] as const).sort((a, b) => total(b[1]) - total(a[1]) || a[0].localeCompare(b[0]))
  }, [map])
  return (
    <>
      <Head title={tr('adm.w.title')}>
        <p className="adm-week" data-testid="admin-wishes-stats">
          {map ? (
            <>
              {tr('adm.w.range', { days: Math.round((map.to - map.from) / 86_400_000) })} <b className="adm-num">{map.items}</b> {tr('adm.w.items')}
              <span className="adm-sep"> · </span>
              <b className="adm-num">{map.clusters.length}</b> {tr('adm.w.themes')}
            </>
          ) : (
            tr('adm.w.none.short')
          )}
        </p>
        <div className="adm-chips">
          {map && (
            <span className="adm-chip" title={tr('adm.w.built.tip')}>
              {tr('adm.w.built', { when: `${day(map.createdAt, locale)} ${hm(map.createdAt, locale)}`, model: map.model ?? map.provider ?? '—' })}
            </span>
          )}
          <button type="button" className="adm-btn" data-testid="admin-wishes-rebuild" disabled={busy} title={tr('adm.w.rebuild.tip')} onClick={() => void rebuild()}>
            {busy ? tr('adm.w.rebuilding') : tr('adm.w.rebuild')}
          </button>
        </div>
      </Head>
      <Problem text={error} />
      <div className="adm-scroll">
        <table className="adm-table" data-testid="admin-wishes">
          <colgroup>
            <col className="adm-w-140" />
            <col />
            <col className="adm-w-150" />
            <col className="adm-w-92" />
            <col className="adm-w-70" />
            <col className="adm-w-120" />
          </colgroup>
          <thead>
            <tr>
              <th>{tr('adm.w.col.panel')}</th>
              <th>{tr('adm.w.col.theme')}</th>
              <th>{tr('adm.w.col.kind')}</th>
              <th className="adm-r">{tr('adm.w.col.requests')}</th>
              <th className="adm-r">{tr('adm.w.col.users')}</th>
              <th className="adm-pl">{tr('adm.w.col.last')}</th>
            </tr>
          </thead>
          <tbody>
            {map !== undefined && groups.length === 0 && (
              <tr>
                <td colSpan={6} className="adm-empty">
                  {map ? tr('adm.w.empty') : tr('adm.w.none')}
                </td>
              </tr>
            )}
            {groups.map(([panel, ks]) =>
              ks.map((k, i) => (
                <tr key={`${panel}\0${k.title}`} className={`adm-line${i === 0 ? ' adm-group' : ''}`} data-testid="admin-wish" data-panel={panel} data-kind={k.kind}>
                  <td className="adm-panel">{i === 0 ? panel : ''}</td>
                  <td>
                    <span className="adm-text">{k.title}</span>
                    {k.examples.slice(0, 2).map((x, j) => (
                      <span key={j} className="adm-quote">
                        “{x}”
                      </span>
                    ))}
                  </td>
                  <td className="adm-outcome">
                    <span className="adm-mark" aria-hidden="true">
                      {k.kind === 'needs-backend' ? '▸' : '–'}
                    </span>
                    <span className="adm-otext">{tr(k.kind === 'needs-backend' ? 'adm.w.kind.backend' : 'adm.w.kind.zone')}</span>
                  </td>
                  <td className="adm-big">{k.requests}</td>
                  <td className="adm-cost">{k.users}</td>
                  <TimeCell iso={k.lastAt} locale={locale} className="adm-pl" />
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
      <p className="adm-foot">{tr('adm.w.foot')}</p>
    </>
  )
}

// --- C11: code search and rollback by selection ---

interface GrepRow {
  userId: string
  orgId: string
  snapshotId: string
  isHead: boolean
  createdAt: string
  author: string
  message: string
  matches: { file: string; line: number; text: string }[]
}
interface GrepResult {
  grep: string
  scope: 'heads' | 'all'
  count: number
  rows: GrepRow[]
}

function Highlight({ text, needle }: { text: string; needle: string }) {
  const parts = text.split(needle)
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {p}
          {i < parts.length - 1 && <mark className="adm-hit">{needle}</mark>}
        </Fragment>
      ))}
    </>
  )
}

export function SnapshotsScreen({ call, tr, locale }: ScreenProps) {
  const initial = new URLSearchParams(location.search).get('grep') ?? ''
  const [q, setQ] = useState(initial)
  const [scope, setScope] = useState<'heads' | 'all'>('heads')
  const [result, setResult] = useState<GrepResult | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const search = useCallback(
    async (needle: string, where: 'heads' | 'all') => {
      if (needle.length < 2) return
      try {
        setResult(await call<GrepResult>(`/admin/snapshots?grep=${encodeURIComponent(needle)}&scope=${where}`))
        setError(null)
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [call],
  )
  useEffect(() => {
    if (initial) void search(initial, 'heads')
  }, [initial, search])
  const rollback = async () => {
    if (!result) return
    try {
      const r = await call<{ rolledBack: number; users: string[]; skipped: string[] }>('/admin/snapshots/rollback', { method: 'POST', body: JSON.stringify({ grep: result.grep, confirm: result.count }) })
      setMsg(tr('adm.s.done', { n: r.rolledBack, users: r.users.join(', ') || '—' }))
      setConfirming(false)
      await search(result.grep, result.scope)
    } catch (e) {
      setMsg((e as Error).message)
      setConfirming(false)
    }
  }
  const live = result?.scope === 'heads' ? result.count : 0
  return (
    <>
      <Head title={tr('adm.s.title')}>
        <form
          className="adm-form"
          data-testid="admin-grep-form"
          onSubmit={(e) => {
            e.preventDefault()
            setMsg(null)
            setConfirming(false)
            void search(q, scope)
          }}
        >
          <input className="adm-input" data-testid="admin-grep" value={q} placeholder={tr('adm.s.placeholder')} aria-label={tr('adm.s.placeholder')} onChange={(e) => setQ(e.target.value)} />
          <span className="adm-seg" role="group" aria-label={tr('adm.s.scope')}>
            {(['heads', 'all'] as const).map((s) => (
              <button key={s} type="button" aria-pressed={scope === s} data-testid={`admin-grep-scope-${s}`} onClick={() => setScope(s)}>
                {tr(s === 'heads' ? 'adm.s.heads' : 'adm.s.all')}
              </button>
            ))}
          </span>
          <button type="submit" className="adm-btn" data-testid="admin-grep-go" disabled={q.length < 2}>
            {tr('adm.s.search')}
          </button>
        </form>
        {result && (
          <p className="adm-week" data-testid="admin-grep-count">
            {tr(result.scope === 'heads' ? 'adm.s.count.heads' : 'adm.s.count.all', { n: result.count })} <code className="adm-mono">{result.grep}</code>
          </p>
        )}
      </Head>
      <Problem text={error} />
      {result && (
        <div className="adm-scroll">
          <table className="adm-table" data-testid="admin-grep-results">
            <colgroup>
              <col className="adm-w-92" />
              <col className="adm-w-92" />
              <col className="adm-w-196" />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th>{tr('adm.col.time')}</th>
                <th>{tr('admin.col.user')}</th>
                <th>{tr('adm.s.col.version')}</th>
                <th>{tr('adm.s.col.match')}</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="adm-empty">
                    {tr('adm.s.empty')}
                  </td>
                </tr>
              )}
              {result.rows.map((r) => (
                <tr key={r.snapshotId} className={`adm-line${r.isHead ? ' adm-t-pending' : ''}`} data-testid="admin-grep-row" data-user={r.userId} data-head={r.isHead}>
                  <TimeCell iso={r.createdAt} locale={locale} />
                  <td className="adm-user">{r.userId}</td>
                  <td>
                    <span className="adm-mono">{r.snapshotId.slice(-8)}</span>
                    {r.isHead && <span className="adm-live">{tr('admin.live')}</span>}
                    <span className="adm-summary">{r.message}</span>
                  </td>
                  <td>
                    {r.matches.map((m, i) => (
                      <div key={i} className="adm-match">
                        <span className="adm-loc">
                          {m.file}:{m.line}
                        </span>
                        <code className="adm-code">
                          <Highlight text={m.text} needle={result.grep} />
                        </code>
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {live > 0 && !confirming && (
        <div className="adm-actions adm-after">
          <button type="button" className="adm-btn adm-btn-main" data-testid="admin-grep-rollback" title={tr('adm.s.rollback.tip')} onClick={() => setConfirming(true)}>
            {tr('adm.s.rollback', { n: live })}
          </button>
        </div>
      )}
      {confirming && (
        <div className="adm-confirm" data-testid="admin-grep-confirm">
          <span>{tr('adm.s.confirm', { n: live })}</span>
          <button type="button" className="adm-btn adm-btn-main" data-testid="admin-grep-confirm-go" onClick={() => void rollback()}>
            {tr('adm.s.confirm.go', { n: live })}
          </button>
          <button type="button" className="adm-btn adm-btn-quiet" onClick={() => setConfirming(false)}>
            {tr('adm.cancel')}
          </button>
        </div>
      )}
      {msg && (
        <p className="adm-msg adm-after" data-testid="admin-grep-msg">
          {msg}
        </p>
      )}
    </>
  )
}

// --- C10: releases (bulk carry-over runs) ---

interface ReleaseRow {
  release: string
  status: 'running' | 'done' | 'budget' | 'rolled-back'
  budgetUsd: number
  spentUsd: number
  createdAt: string
  updatedAt: string
  rolledBackAt: string | null
  counts: Record<string, number>
}
interface ReleaseItem {
  userId: string
  fromSnapshot: string
  toSnapshot: string | null
  state: string
  costUsd: number
  error: string | null
}

const RELEASE_MARK: Record<ReleaseRow['status'], { mark: string; tone: 'ok' | 'pending' | 'quiet' }> = {
  done: { mark: '✓', tone: 'ok' },
  running: { mark: '▸', tone: 'quiet' },
  budget: { mark: '▸', tone: 'pending' },
  'rolled-back': { mark: '↶', tone: 'quiet' },
}

export function ReleasesScreen({ call, tr, locale }: ScreenProps) {
  const [rows, setRows] = useState<ReleaseRow[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => call<ReleaseRow[]>('/admin/releases').then(setRows, (e: Error) => setError(e.message)), [call])
  useEffect(() => void load(), [load])
  const waiting = (rows ?? []).reduce((n, r) => n + (r.status === 'rolled-back' ? 0 : (r.counts.budget ?? 0)), 0)
  return (
    <>
      <Head title={tr('adm.r.title')}>
        <p className="adm-week">
          {tr('adm.r.runs')} <b className="adm-num">{rows?.length ?? 0}</b>
          {waiting > 0 && (
            <>
              <span className="adm-sep"> · </span>
              {tr('adm.r.waiting')} <b className="adm-num">{waiting}</b>
            </>
          )}
        </p>
        <span className="adm-chip" title={tr('adm.r.cli.tip')}>
          <code className="adm-chipcode">pleatkit carry-over --release &lt;hash&gt; --budget-usd 5</code>
        </span>
      </Head>
      <Problem text={error} />
      <div className="adm-scroll">
        <table className="adm-table" data-testid="admin-releases">
          <colgroup>
            <col className="adm-w-92" />
            <col className="adm-w-160" />
            <col className="adm-w-150" />
            <col />
            <col className="adm-w-140" />
            <col className="adm-c-chev" />
          </colgroup>
          <thead>
            <tr>
              <th>{tr('adm.r.col.started')}</th>
              <th>{tr('adm.r.col.release')}</th>
              <th>{tr('adm.r.col.status')}</th>
              <th>{tr('adm.r.col.users')}</th>
              <th className="adm-r">{tr('adm.r.col.spent')}</th>
              <th aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {rows && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="adm-empty">
                  {tr('adm.r.empty')}
                </td>
              </tr>
            )}
            {(rows ?? []).map((r) => {
              const m = RELEASE_MARK[r.status] ?? RELEASE_MARK.running
              const isOpen = open === r.release
              const parts = (['carried', 'migrated', 'current', 'stale', 'budget', 'failed', 'moved', 'rolled-back', 'kept'] as const).filter((k) => r.counts[k]).map((k) => tr(`adm.r.state.${k}` as K, { n: r.counts[k]! }))
              return (
                <Fragment key={r.release}>
                  <tr className={`adm-row adm-t-${m.tone}${isOpen ? ' adm-open' : ''}`} data-testid="admin-release" data-release={r.release} data-status={r.status} onClick={() => setOpen(isOpen ? null : r.release)}>
                    <TimeCell iso={r.createdAt} locale={locale} />
                    <td className="adm-mono">{r.release}</td>
                    <td className="adm-outcome">
                      <span className="adm-mark" aria-hidden="true">
                        {m.mark}
                      </span>
                      <span className="adm-otext">{tr(`adm.r.status.${r.status}` as K)}</span>
                    </td>
                    <td className="adm-summary-cell">{parts.join(' · ') || '—'}</td>
                    <td className="adm-cost">
                      {usd(r.spentUsd)} <span className="adm-of">/ {usd(r.budgetUsd)}</span>
                    </td>
                    <td className="adm-chevcell">
                      <button type="button" className="adm-disclose" aria-expanded={isOpen} aria-label={tr('adm.open')}>
                        <svg className={isOpen ? 'adm-chev adm-chev-open' : 'adm-chev'} viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M6 3.5 10.5 8 6 12.5" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="adm-detailrow">
                      <td colSpan={6}>
                        <ReleaseDetail release={r} call={call} tr={tr} onChanged={load} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

function ReleaseDetail({ release, call, tr, onChanged }: { release: ReleaseRow; call: AdminCall; tr: AdminTranslate; onChanged: () => Promise<void> }) {
  const [items, setItems] = useState<ReleaseItem[] | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const load = useCallback(() => call<{ items: ReleaseItem[] }>(`/admin/releases/${release.release}`).then((r) => setItems(r.items)), [call, release.release])
  useEffect(() => void load(), [load])
  const moved = (items ?? []).filter((i) => i.toSnapshot && i.state !== 'rolled-back' && i.state !== 'kept').length
  const rollback = async () => {
    try {
      const r = await call<{ restored: string[]; kept: string[] }>(`/admin/releases/${release.release}/rollback`, { method: 'POST', body: '{}' })
      setMsg(tr('adm.r.done', { n: r.restored.length, kept: r.kept.length }))
      setConfirming(false)
      await Promise.all([load(), onChanged()])
    } catch (e) {
      setMsg((e as Error).message)
    }
  }
  if (!items) return <p className="adm-loading">{tr('admin.loading')}</p>
  return (
    <div className="adm-detail" data-testid="admin-release-detail">
      <table className="adm-items">
        <thead>
          <tr>
            <th>{tr('admin.col.user')}</th>
            <th>{tr('adm.r.col.how')}</th>
            <th>{tr('adm.r.col.before')}</th>
            <th>{tr('adm.r.col.after')}</th>
            <th className="adm-r">{tr('admin.col.cost')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.userId} data-testid="admin-release-item" data-state={i.state} className={i.state === 'failed' ? 'adm-bad' : undefined}>
              <td>{i.userId}</td>
              <td>
                {tr(`adm.r.how.${i.state}` as K)}
                {i.error && <span className="adm-loc">{i.error}</span>}
              </td>
              <td className="adm-mono">{i.fromSnapshot.slice(-8)}</td>
              <td className="adm-mono">{i.toSnapshot ? i.toSnapshot.slice(-8) : '—'}</td>
              <td className="adm-r adm-mono">{i.costUsd ? usd(i.costUsd) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="adm-actions">
        {release.status !== 'rolled-back' && moved > 0 && !confirming && (
          <button type="button" className="adm-btn" data-testid="admin-release-rollback" title={tr('adm.r.rollback.tip')} onClick={() => setConfirming(true)}>
            {tr('adm.r.rollback')}
          </button>
        )}
        {confirming && (
          <>
            <span className="adm-d-note">{tr('adm.r.confirm', { n: moved })}</span>
            <button type="button" className="adm-btn adm-btn-main" data-testid="admin-release-rollback-go" onClick={() => void rollback()}>
              {tr('adm.r.confirm.go', { n: moved })}
            </button>
            <button type="button" className="adm-btn adm-btn-quiet" onClick={() => setConfirming(false)}>
              {tr('adm.cancel')}
            </button>
          </>
        )}
        {msg && (
          <span className="adm-msg" data-testid="admin-release-msg">
            {msg}
          </span>
        )}
      </div>
    </div>
  )
}

// --- F6: flags ---

interface FlagRow {
  scope: 'app' | 'org' | 'user'
  scopeId: string
  key: string
  value: unknown
  updatedAt: string
}
const KNOWN_FLAGS = ['pleatkit.enabled', 'edits.enabled'] as const

export function FlagsScreen({ call, tr, locale }: ScreenProps) {
  const [rows, setRows] = useState<FlagRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ scope: 'user' as FlagRow['scope'], scopeId: '', key: 'edits.enabled', value: 'false' })
  const load = useCallback(() => call<{ flags: FlagRow[] }>('/admin/flags').then((r) => setRows(r.flags), (e: Error) => setError(e.message)), [call])
  useEffect(() => void load(), [load])
  const put = async (body: Record<string, unknown>) => {
    try {
      setRows((await call<{ flags: FlagRow[] }>('/admin/flags', { method: 'PUT', body: JSON.stringify(body) })).flags)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const app = (key: string) => (rows ?? []).find((r) => r.scope === 'app' && r.key === key)?.value
  const killed = app('pleatkit.enabled') === false
  const paused = app('edits.enabled') === false
  return (
    <>
      <Head title={tr('adm.f.title')}>
        <p className="adm-week" data-testid="admin-flags-state">
          {tr('adm.f.state.pleatkit')} <b className={killed ? 'adm-redword' : undefined}>{tr(killed ? 'adm.f.off' : 'adm.f.on')}</b>
          <span className="adm-sep"> · </span>
          {tr('adm.f.state.edits')} <b className={paused ? 'adm-redword' : undefined}>{tr(paused ? 'adm.f.off' : 'adm.f.on')}</b>
        </p>
        <span className="adm-chip">{tr('adm.f.order')}</span>
      </Head>
      <Problem text={error} />
      <div className="adm-scroll">
        <table className="adm-table" data-testid="admin-flags">
          <colgroup>
            <col className="adm-w-92" />
            <col className="adm-w-140" />
            <col />
            <col className="adm-w-120" />
            <col className="adm-w-92" />
            <col className="adm-w-92" />
          </colgroup>
          <thead>
            <tr>
              <th>{tr('adm.f.col.scope')}</th>
              <th>{tr('adm.f.col.who')}</th>
              <th>{tr('adm.f.col.key')}</th>
              <th>{tr('adm.f.col.value')}</th>
              <th>{tr('adm.f.col.updated')}</th>
              <th aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {rows && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="adm-empty">
                  {tr('adm.f.empty')}
                </td>
              </tr>
            )}
            {(rows ?? []).map((r) => (
              <tr key={`${r.scope}:${r.scopeId}:${r.key}`} className="adm-line" data-testid="admin-flag" data-key={r.key} data-scope={r.scope}>
                <td className="adm-mono">{r.scope}</td>
                <td className="adm-user">{r.scopeId || tr('adm.f.everyone')}</td>
                <td className="adm-mono">{r.key}</td>
                <td className="adm-outcome">
                  <span className={`adm-mono${r.value === false ? ' adm-redword' : ''}`}>{JSON.stringify(r.value)}</span>
                </td>
                <TimeCell iso={r.updatedAt} locale={locale} />
                <td className="adm-r">
                  <button type="button" className="adm-link" data-testid="admin-flag-remove" onClick={() => void put({ scope: r.scope, scopeId: r.scopeId, key: r.key, value: null })}>
                    {tr('adm.f.remove')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form
        className="adm-form adm-after"
        data-testid="admin-flag-form"
        onSubmit={(e) => {
          e.preventDefault()
          void put({ scope: form.scope, scopeId: form.scopeId, key: form.key, value: form.value === 'true' ? true : form.value === 'false' ? false : form.value })
        }}
      >
        <span className="adm-h4 adm-inline">{tr('adm.f.set')}</span>
        <select className="adm-select" aria-label={tr('adm.f.col.scope')} data-testid="admin-flag-scope" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as FlagRow['scope'] })}>
          {(['app', 'org', 'user'] as const).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {form.scope !== 'app' && (
          <input className="adm-input adm-input-s" aria-label={tr('adm.f.col.who')} data-testid="admin-flag-id" placeholder={tr(form.scope === 'org' ? 'adm.f.org' : 'adm.f.user')} value={form.scopeId} onChange={(e) => setForm({ ...form, scopeId: e.target.value })} />
        )}
        <select className="adm-select" aria-label={tr('adm.f.col.key')} data-testid="admin-flag-key" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })}>
          {KNOWN_FLAGS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select className="adm-select" aria-label={tr('adm.f.col.value')} data-testid="admin-flag-value" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })}>
          <option value="false">false</option>
          <option value="true">true</option>
        </select>
        <button type="submit" className="adm-btn" data-testid="admin-flag-set" disabled={form.scope !== 'app' && !form.scopeId}>
          {tr('adm.f.save')}
        </button>
      </form>
      <p className="adm-foot">{tr('adm.f.foot')}</p>
    </>
  )
}

// --- F3: events feed ---

interface EventRow {
  seq: number
  ts: string
  type: string
  userId: string | null
  value: number
  unit: string
  requestId: string | null
  source: string
  orgId: string
}
const EVENT_TYPES = ['edit.requested', 'edit.applied', 'edit.reverted', 'edit.alive24h', 'editor.active', 'tokens.used', 'cost.usd'] as const

export function EventsScreen({ call, tr, locale }: ScreenProps) {
  const [rows, setRows] = useState<EventRow[] | null>(null)
  const [type, setType] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const since = useMemo(() => Date.now() - 7 * 86_400_000, [])
  useEffect(() => {
    call<EventRow[]>(`/admin/events?since=${since}&limit=1000${type ? `&type=${encodeURIComponent(type)}` : ''}`).then(setRows, (e: Error) => setError(e.message))
  }, [call, type, since])
  const count = (t: string) => (rows ?? []).filter((e) => e.type === t).length
  const cost = (rows ?? []).filter((e) => e.type === 'cost.usd').reduce((s, e) => s + e.value, 0)
  return (
    <>
      <Head title={tr('adm.e.title')}>
        <p className="adm-week" data-testid="admin-events-stats">
          {tr('adm.e.week')} <b className="adm-num">{count('edit.requested')}</b> {tr('adm.e.requested')}
          <span className="adm-sep"> · </span>
          <b className="adm-num">{count('edit.applied')}</b> {tr('adm.e.applied')}
          <span className="adm-sep"> · </span>
          <b className="adm-num">{count('edit.reverted')}</b> {tr('adm.e.reverted')}
          {!type && (
            <>
              <span className="adm-sep"> · </span>
              <b className="adm-num">{usd(cost)}</b>
            </>
          )}
        </p>
        <div className="adm-chips adm-wrap">
          {[null, ...EVENT_TYPES].map((t) => (
            <button key={t ?? 'all'} type="button" className="adm-chip adm-chip-ink" aria-pressed={type === t} data-testid={`admin-events-type-${t ?? 'all'}`} onClick={() => setType(t)}>
              {t ?? tr('adm.e.all')}
            </button>
          ))}
        </div>
      </Head>
      <Problem text={error} />
      <div className="adm-scroll">
        <table className="adm-table" data-testid="admin-events">
          <colgroup>
            <col className="adm-w-92" />
            <col className="adm-w-150" />
            <col className="adm-w-92" />
            <col className="adm-w-140" />
            <col />
            <col className="adm-w-70" />
          </colgroup>
          <thead>
            <tr>
              <th>{tr('adm.col.time')}</th>
              <th>{tr('adm.e.col.type')}</th>
              <th>{tr('admin.col.user')}</th>
              <th className="adm-r">{tr('adm.e.col.value')}</th>
              <th>{tr('adm.e.col.request')}</th>
              <th>{tr('adm.e.col.source')}</th>
            </tr>
          </thead>
          <tbody>
            {rows && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="adm-empty">
                  {tr('adm.e.empty')}
                </td>
              </tr>
            )}
            {(rows ?? []).slice(0, 300).map((e) => (
              <tr key={e.seq} className="adm-line" data-testid="admin-event" data-type={e.type}>
                <TimeCell iso={e.ts} locale={locale} />
                <td className="adm-mono">{e.type}</td>
                <td className="adm-user">{e.userId ?? '—'}</td>
                <td className="adm-cost">
                  {e.unit === 'usd' ? usd(e.value) : e.value.toLocaleString(locale)} <span className="adm-of">{e.unit === 'usd' ? '' : e.unit}</span>
                </td>
                <td className="adm-mono adm-dim">{e.requestId ? e.requestId.slice(-12) : '—'}</td>
                <td className="adm-dim">{e.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

// --- F7: audit chain ---

interface AuditRow {
  seq: number
  ts: string
  actor: string
  action: string
  objectType: string
  objectId: string | null
  hash: string
}

export function AuditScreen({ call, tr, locale }: ScreenProps) {
  const [data, setData] = useState<{ rows: AuditRow[]; verify?: { ok: boolean; rows: number; brokenAt: number | null } } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => call<NonNullable<typeof data>>('/admin/audit?verify=1&limit=200').then(setData, (e: Error) => setError(e.message)), [call])
  useEffect(() => void load(), [load])
  const v = data?.verify
  return (
    <>
      <Head title={tr('adm.a.title')}>
        <p className={`adm-week${v && !v.ok ? ' adm-redword' : ''}`} data-testid="admin-audit-verify" data-ok={v ? String(v.ok) : undefined}>
          {v ? (
            v.ok ? (
              <>
                <span className="adm-okmark" aria-hidden="true">
                  ✓{' '}
                </span>
                {tr('adm.a.ok', { n: v.rows })}
              </>
            ) : (
              tr('adm.a.broken', { at: v.brokenAt ?? '?', n: v.rows })
            )
          ) : (
            tr('admin.loading')
          )}
        </p>
        <button type="button" className="adm-btn" data-testid="admin-audit-reverify" title={tr('adm.a.verify.tip')} onClick={() => void load()}>
          {tr('adm.a.verify')}
        </button>
      </Head>
      <Problem text={error} />
      <div className="adm-scroll">
        <table className="adm-table" data-testid="admin-audit">
          <colgroup>
            <col className="adm-w-60" />
            <col className="adm-w-92" />
            <col className="adm-w-196" />
            <col className="adm-w-196" />
            <col />
            <col className="adm-w-120" />
          </colgroup>
          <thead>
            <tr>
              <th>#</th>
              <th>{tr('adm.col.time')}</th>
              <th>{tr('adm.a.col.actor')}</th>
              <th>{tr('adm.a.col.action')}</th>
              <th>{tr('adm.a.col.object')}</th>
              <th>{tr('adm.a.col.hash')}</th>
            </tr>
          </thead>
          <tbody>
            {(data?.rows ?? []).map((r) => {
              const as = r.actor.includes(':as:')
              return (
                <tr key={r.seq} className={`adm-line${v && !v.ok && v.brokenAt === r.seq ? ' adm-t-pending' : ''}`} data-testid="admin-audit-row" data-action={r.action}>
                  <td className="adm-mono adm-dim">{r.seq}</td>
                  <TimeCell iso={r.ts} locale={locale} />
                  <td className="adm-user" title={as ? tr('adm.a.as.tip') : undefined}>
                    {as ? (
                      <>
                        {r.actor.split(':as:')[0]} <span className="adm-as">{tr('adm.a.as')}</span> {r.actor.split(':as:')[1]}
                      </>
                    ) : (
                      r.actor
                    )}
                  </td>
                  <td className="adm-mono">{r.action}</td>
                  <td className="adm-dim">
                    {r.objectType}
                    {r.objectId ? <span className="adm-mono"> {r.objectId.length > 26 ? `…${r.objectId.slice(-12)}` : r.objectId}</span> : null}
                  </td>
                  <td className="adm-mono adm-dim">{r.hash.slice(0, 12)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

// --- F14: plan and usage ---

/** Mirror of the agent's plans (packages/agent/src/quota.ts): the store keeps only an app's overrides. */
const PLANS: Record<string, Record<string, number>> = {
  free: { perEditUsd: 0.3, userDailyUsd: 1, userDailyEdits: 30, appDailyUsd: 10, appDailyEdits: 300, userDailyCompiles: 500 },
  team: { perEditUsd: 0.5, userDailyUsd: 3, userDailyEdits: 100, appDailyUsd: 100, appDailyEdits: 3000, userDailyCompiles: 2000 },
}
const LIMIT_KEYS = ['perEditUsd', 'userDailyUsd', 'userDailyEdits', 'appDailyUsd', 'appDailyEdits', 'userDailyCompiles'] as const

export function PlanScreen({ call, tr, locale }: ScreenProps) {
  const [plan, setPlan] = useState<{ plan: string | null; limits: Record<string, number> } | null>(null)
  const [events, setEvents] = useState<EventRow[]>([])
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const since = useMemo(() => Date.now() - 7 * 86_400_000, [])
  const load = useCallback(async () => {
    try {
      const [p, e] = await Promise.all([call<{ plan: string | null; limits: Record<string, number> }>('/admin/plan'), call<EventRow[]>(`/admin/events?since=${since}&limit=5000`)])
      setPlan(p)
      setEvents(e)
      setDraft(Object.fromEntries(Object.entries(p.limits).map(([k, v]) => [k, String(v)])))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [call, since])
  useEffect(() => void load(), [load])
  const name = plan?.plan ?? 'free'
  const base = PLANS[name] ?? PLANS.free!
  const effective = (k: string) => plan?.limits[k] ?? base[k]!
  const today = new Date().toISOString().slice(0, 10)
  const days = useMemo(() => {
    const by = new Map<string, { requests: number; applied: number; editors: number; cost: number }>()
    for (let i = 6; i >= 0; i--) by.set(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10), { requests: 0, applied: 0, editors: 0, cost: 0 })
    for (const e of events) {
      const d = by.get(e.ts.slice(0, 10))
      if (!d) continue
      if (e.type === 'edit.requested') d.requests++
      if (e.type === 'edit.applied') d.applied++
      if (e.type === 'editor.active') d.editors++
      if (e.type === 'cost.usd') d.cost += e.value
    }
    return [...by.entries()].reverse()
  }, [events])
  const t = days.find(([d]) => d === today)?.[1] ?? { requests: 0, applied: 0, editors: 0, cost: 0 }
  const save = async () => {
    const limits: Record<string, number> = {}
    for (const [k, v] of Object.entries(draft)) if (v.trim() !== '' && Number.isFinite(Number(v))) limits[k] = Number(v)
    try {
      setPlan(await call('/admin/plan', { method: 'PUT', body: JSON.stringify({ plan: name, limits }) }))
      setMsg(tr('adm.p.saved'))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <>
      <Head title={tr('adm.p.title')}>
        <p className="adm-week" data-testid="admin-plan-today">
          {tr('adm.p.plan')} <b>{name}</b>
          {!plan?.plan && <span className="adm-dim"> ({tr('adm.p.default')})</span>}
          <span className="adm-sep"> · </span>
          {tr('adm.p.today')} <b className="adm-num">{usd(t.cost)}</b> {tr('adm.p.of')} <b className="adm-num">{usd(effective('appDailyUsd'))}</b>
          <span className="adm-sep"> · </span>
          <b className="adm-num">{t.requests}</b> {tr('adm.p.of')} <b className="adm-num">{effective('appDailyEdits').toLocaleString(locale)}</b> {tr('adm.p.edits')}
        </p>
      </Head>
      <Problem text={error} />
      <div className="adm-split">
        <section>
          <h2 className="adm-h2">{tr('adm.p.limits')}</h2>
          <table className="adm-table" data-testid="admin-plan-limits">
            <colgroup>
              <col />
              <col className="adm-w-120" />
              <col className="adm-w-120" />
            </colgroup>
            <thead>
              <tr>
                <th>{tr('adm.p.col.limit')}</th>
                <th className="adm-r">{tr('adm.p.col.plan')}</th>
                <th className="adm-r">{tr('adm.p.col.override')}</th>
              </tr>
            </thead>
            <tbody>
              {LIMIT_KEYS.map((k) => (
                <tr key={k} className="adm-line" data-testid="admin-plan-limit" data-key={k}>
                  <td>
                    <span className="adm-text">{tr(`adm.p.limit.${k}` as K)}</span>
                    <span className="adm-loc">{k}</span>
                  </td>
                  <td className="adm-cost">{k.endsWith('Usd') ? usd(base[k]!) : base[k]!.toLocaleString(locale)}</td>
                  <td className="adm-r">
                    <input className="adm-input adm-input-n" inputMode="decimal" aria-label={k} data-testid={`admin-plan-${k}`} placeholder="—" value={draft[k] ?? ''} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="adm-actions adm-after">
            <button type="button" className="adm-btn" data-testid="admin-plan-save" onClick={() => void save()}>
              {tr('adm.p.save')}
            </button>
            {msg && (
              <span className="adm-msg" data-testid="admin-plan-msg">
                {msg}
              </span>
            )}
          </div>
        </section>
        <section>
          <h2 className="adm-h2">{tr('adm.p.usage')}</h2>
          <div className="adm-scroll">
            <table className="adm-table" data-testid="admin-plan-usage">
              <colgroup>
                <col className="adm-w-92" />
                <col />
                <col />
                <col />
                <col className="adm-w-92" />
              </colgroup>
              <thead>
                <tr>
                  <th>{tr('adm.p.col.day')}</th>
                  <th className="adm-r">{tr('adm.p.col.requests')}</th>
                  <th className="adm-r">{tr('adm.p.col.applied')}</th>
                  <th className="adm-r">{tr('adm.p.col.editors')}</th>
                  <th className="adm-r">{tr('admin.col.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {days.map(([d, x]) => (
                  <tr key={d} className={`adm-line${d === today ? ' adm-today' : ''}`} data-testid="admin-plan-day">
                    <td className="adm-time">
                      <span className="adm-hm">{new Date(`${d}T12:00:00Z`).toLocaleDateString(locale, { day: '2-digit', month: 'short' })}</span>
                    </td>
                    <td className="adm-cost">{x.requests}</td>
                    <td className="adm-cost">{x.applied}</td>
                    <td className="adm-cost">{x.editors}</td>
                    <td className="adm-cost">{usd(x.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      <p className="adm-foot">{tr('adm.p.foot')}</p>
    </>
  )
}
