import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { diffLines } from 'diff'
import type { Locale, Moderation, Snapshot, ToolLogEntry, UsageByModel } from '@morphkit/runtime'
import { translator, type Translate, type UiKey } from '@morphkit/ui'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { AUTH, STORE_URL, tokenFor } from './morphkit'

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
      const auth: Record<string, string> = AUTH === 'token' ? { authorization: `Bearer ${await tokenFor('admin', 'admin')}` } : { 'x-morphkit-admin': '1' }
      const res = await fetch(`${STORE_URL}/v1${path}`, {
        ...init,
        headers: { ...auth, 'x-morphkit-app': appId, 'content-type': 'application/json', ...init?.headers },
      })
      const body = (await res.json().catch(() => ({}))) as T & { error?: string }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      return body
    },
    [appId],
  )
}

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`)
const cost = (u: UsageByModel[] | null) => (u ?? []).reduce((s, x) => s + (x.costUsd ?? 0), 0)

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'secondary' | 'destructive'> = {
  applied: 'success',
  proposed: 'secondary',
  'pending-review': 'warning',
  'pending-admin': 'warning',
  'in-progress': 'warning',
  'rolled-back': 'secondary',
  rejected: 'destructive',
  failed: 'destructive',
  refused: 'secondary',
}

const label = (tr: Translate, prefix: 'status' | 'verdict', value: string) => tr(`${prefix}.${value}` as UiKey)

/** /admin: every agent request of the app, what happened to it, and the admin's levers. */
export function Admin({ appId, locale = 'en' }: { appId: string; locale?: Locale }) {
  const tr = useMemo(() => translator(locale), [locale])
  const call = useAdminApi(appId)
  const [rows, setRows] = useState<RequestRow[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [open, setOpen] = useState<string | null>(null)
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

  return (
    <div className="min-h-screen" lang={locale}>
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold">Acme CRM</span>
            <span className="text-xs text-muted-foreground">
              {tr('admin.title')} · {appId}
            </span>
          </div>
          <a className="text-sm text-muted-foreground hover:underline" href={`/${query ? `?${query}` : ''}`}>
            {tr('admin.back')}
          </a>
        </div>
      </header>
      <main className="mx-auto grid max-w-6xl gap-6 px-6 py-6" data-testid="admin">
        <div className="grid gap-4 sm:grid-cols-5" data-testid="admin-stats">
          <Stat label={tr('admin.stat.edits')} value={String(stats?.editsThisWeek ?? '—')} testId="stat-edits" />
          <Stat label={tr('admin.stat.total')} value={String(stats?.total ?? '—')} testId="stat-total" />
          <Stat label={tr('admin.stat.success')} value={pct(stats?.successRate ?? null)} testId="stat-success" />
          <Stat label={tr('admin.stat.backend')} value={pct(stats?.needsBackendRate ?? null)} testId="stat-backend" />
          <Stat label={tr('admin.stat.review')} value={String(stats?.pendingReview ?? '—')} testId="stat-review" />
        </div>
        <label className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm" data-testid="admin-moderation">
          <input
            type="checkbox"
            className="mt-1"
            data-testid="admin-moderation-toggle"
            checked={stats?.moderation === 'review'}
            disabled={!stats}
            onChange={(e) => void setModeration(e.target.checked ? 'review' : 'off')}
          />
          <span>
            <span className="font-medium">{tr('admin.moderation')}</span>
            <span className="block text-xs text-muted-foreground">{tr('admin.moderation.hint')}</span>
          </span>
        </label>
        {error && <p className="text-sm text-red-700">Store-server: {error}</p>}
        <Card>
          <CardHeader>
            <CardTitle>{tr('admin.requests')}</CardTitle>
            <CardDescription>{tr('admin.requests.hint')}</CardDescription>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm" data-testid="admin-requests">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-2 pr-3 font-medium">{tr('admin.col.when')}</th>
                  <th className="py-2 pr-3 font-medium">{tr('admin.col.user')}</th>
                  <th className="py-2 pr-3 font-medium">{tr('admin.col.request')}</th>
                  <th className="py-2 pr-3 font-medium">{tr('admin.col.verdict')}</th>
                  <th className="py-2 pr-3 font-medium">{tr('admin.col.status')}</th>
                  <th className="py-2 pr-3 text-right font-medium">{tr('admin.col.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-muted-foreground">
                      {tr('admin.empty')}
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr
                      className={cn(
                        'cursor-pointer border-b border-border align-top hover:bg-muted',
                        r.status === 'pending-review' && 'bg-amber-50',
                        open === r.id && 'bg-muted',
                      )}
                      onClick={() => setOpen(open === r.id ? null : r.id)}
                      data-testid="admin-row"
                      data-request-id={r.id}
                      data-status={r.status}
                      data-verdict={r.verdict}
                    >
                      <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                        {new Date(r.createdAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })}
                      </td>
                      <td className="py-2 pr-3">{r.userId}</td>
                      <td className="py-2 pr-3">
                        {r.text}
                        <div className="text-xs text-muted-foreground">{r.summary}</div>
                      </td>
                      <td className="py-2 pr-3">
                        <Badge variant={r.verdict === 'ok' ? 'success' : r.verdict === 'needs-backend' ? 'warning' : r.verdict === 'clarify' ? 'secondary' : 'destructive'}>{label(tr, 'verdict', r.verdict)}</Badge>
                      </td>
                      <td className="py-2 pr-3" data-testid="admin-status">
                        <Badge variant={STATUS_VARIANT[r.status] ?? 'secondary'}>{label(tr, 'status', r.status)}</Badge>
                        {r.isHead && <span className="ml-1 text-xs text-muted-foreground">{tr('admin.live')}</span>}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{r.provider === 'scripted' ? 'scripted' : `$${cost(r.usage).toFixed(4)}`}</td>
                    </tr>
                    {open === r.id && (
                      <tr>
                        <td colSpan={6} className="border-b border-border bg-background p-4">
                          <RequestDetail id={r.id} call={call} tr={tr} onChanged={load} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl" data-testid={testId}>
          {value}
        </CardTitle>
      </CardHeader>
    </Card>
  )
}

function RequestDetail({ id, call, tr, onChanged }: { id: string; call: ReturnType<typeof useAdminApi>; tr: Translate; onChanged: () => Promise<void> }) {
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

  if (!d) return <p className="text-sm text-muted-foreground">{tr('admin.loading')}</p>
  const r = d.request
  const after = d.snapshot?.files ?? r.files ?? {}
  const before = d.parent?.files ?? {}
  const changed = Object.keys({ ...before, ...after })
    .filter((p) => before[p] !== after[p] && (d.snapshot ? true : p in after))
    .sort()

  return (
    <div className="grid gap-4" data-testid="admin-detail">
      <div className="flex flex-wrap items-center gap-2">
        {r.status === 'pending-review' && (
          <Button size="sm" data-testid="admin-approve" onClick={() => void act('approve', tr('admin.done.approve'))}>
            {tr('admin.approve')}
          </Button>
        )}
        {r.isHead && (
          <Button size="sm" variant="outline" data-testid="admin-rollback" onClick={() => void act('rollback', tr('admin.done.rollback'))}>
            {tr('admin.rollback', { user: r.userId })}
          </Button>
        )}
        {r.status !== 'rejected' && r.status !== 'rolled-back' && (
          <Button size="sm" variant="outline" data-testid="admin-reject" onClick={() => void act('reject', tr('admin.done.reject'))}>
            {tr('admin.reject')}
          </Button>
        )}
        {r.status === 'pending-admin' && (
          <Button size="sm" data-testid="admin-approve" onClick={() => void act('approve', tr('admin.done.take'))}>
            {tr('admin.take')}
          </Button>
        )}
        {msg && (
          <span className="text-sm text-muted-foreground" data-testid="admin-msg">
            {msg}
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {r.provider}/{r.model} · classified {r.classification ?? '—'} · {r.timings?.totalMs ?? '—'} ms
          {r.usage?.map((u) => ` · ${u.model}: ${u.inputTokens} in / ${u.outputTokens} out${u.thinkingTokens ? ` (${u.thinkingTokens} thinking)` : ''} / ${u.cacheReadTokens} cached`).join('')}
        </span>
      </div>
      {r.attachments && (r.attachments.images > 0 || r.attachments.targetDomChars > 0) && (
        <p className="text-sm text-muted-foreground" data-testid="admin-attachments">
          {tr('admin.attachments', { images: r.attachments.images, kb: Math.round(r.attachments.imageBytes / 1024), dom: r.attachments.targetDomChars })}
        </p>
      )}
      {r.error && <p className="text-sm text-red-700">{tr(r.verdict === 'failed' && !r.snapshotId ? 'admin.agentError' : 'admin.browserError', { error: r.error })}</p>}

      <div>
        <h4 className="mb-2 text-sm font-semibold">
          {tr('admin.changes')} {d.snapshot ? tr('admin.changes.vsParent') : tr('admin.changes.proposed')}
        </h4>
        {changed.length === 0 && <p className="text-sm text-muted-foreground">{tr('admin.changes.none')}</p>}
        {changed.map((p) => (
          <FileDiff key={p} path={p} before={before[p] ?? ''} after={after[p] ?? ''} />
        ))}
      </div>

      <div>
        <h4 className="mb-2 text-sm font-semibold">{tr('admin.log')}</h4>
        <table className="w-full text-xs" data-testid="admin-log">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="pr-2">#</th>
              <th className="pr-2">{tr('admin.log.tool')}</th>
              <th className="pr-2">{tr('admin.log.input')}</th>
              <th className="pr-2">{tr('admin.log.result')}</th>
              <th className="pr-2 text-right">ms</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {r.log.map((l, i) => (
              <tr key={i} className={cn('border-t border-border align-top', !l.ok && 'text-red-700')} data-testid="admin-log-row" data-tool={l.tool} data-ok={l.ok}>
                <td className="pr-2">{l.turn}</td>
                <td className="pr-2">{l.tool}</td>
                <td className="max-w-[260px] truncate pr-2">{JSON.stringify(l.input)}</td>
                <td className="pr-2 whitespace-pre-wrap">
                  {l.violation && <strong>violation: </strong>}
                  {l.result.length > 400 ? l.result.slice(0, 400) + '…' : l.result}
                </td>
                <td className="pr-2 text-right">{l.ms}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function FileDiff({ path, before, after }: { path: string; before: string; after: string }) {
  const parts = diffLines(before, after)
  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-border" data-testid="admin-diff" data-file={path}>
      <div className="border-b border-border bg-muted px-3 py-1 font-mono text-xs">{path}</div>
      <pre className="max-h-80 overflow-auto p-0 text-xs leading-5">
        {parts.map((part, i) =>
          part.value
            .replace(/\n$/, '')
            .split('\n')
            .map((line, j) => (
              <div key={`${i}-${j}`} className={cn('px-3', part.added && 'bg-green-50 text-green-800', part.removed && 'bg-red-50 text-red-800')}>
                {part.added ? '+ ' : part.removed ? '- ' : '  '}
                {line}
              </div>
            )),
        )}
      </pre>
    </div>
  )
}
