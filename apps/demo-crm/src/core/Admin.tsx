import { Fragment, useCallback, useEffect, useState } from 'react'
import { diffLines } from 'diff'
import type { Snapshot, ToolLogEntry, UsageByModel } from '@morphkit/runtime'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { STORE_URL } from './morphkit'

interface RequestRow {
  id: string
  userId: string
  text: string
  target: string | null
  verdict: 'ok' | 'needs-backend' | 'failed'
  summary: string
  status: string
  classification: string | null
  provider: string | null
  model: string | null
  usage: UsageByModel[] | null
  timings: { totalMs?: number } | null
  snapshotId: string | null
  error: string | null
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
  byStatus: Record<string, number>
}

function useAdminApi(appId: string) {
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const res = await fetch(`${STORE_URL}${path}`, {
        ...init,
        headers: { 'x-morphkit-admin': '1', 'x-morphkit-app': appId, 'content-type': 'application/json', ...init?.headers },
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
  'pending-admin': 'warning',
  'in-progress': 'warning',
  'rolled-back': 'secondary',
  rejected: 'destructive',
  failed: 'destructive',
}

/** /admin: every agent request of the app, what happened to it, and the admin's levers. */
export function Admin({ appId }: { appId: string }) {
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

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold">Acme CRM</span>
            <span className="text-xs text-muted-foreground">morphkit admin · {appId}</span>
          </div>
          <a className="text-sm text-muted-foreground hover:underline" href={`/${appId !== 'demo-crm' ? `?app=${encodeURIComponent(appId)}` : ''}`}>
            Back to the app
          </a>
        </div>
      </header>
      <main className="mx-auto grid max-w-6xl gap-6 px-6 py-6" data-testid="admin">
        <div className="grid gap-4 sm:grid-cols-4" data-testid="admin-stats">
          <Stat label="Edits this week" value={String(stats?.editsThisWeek ?? '—')} testId="stat-edits" />
          <Stat label="Requests this week" value={String(stats?.total ?? '—')} testId="stat-total" />
          <Stat label="Success rate" value={pct(stats?.successRate ?? null)} testId="stat-success" />
          <Stat label="Needs backend" value={pct(stats?.needsBackendRate ?? null)} testId="stat-backend" />
        </div>
        {error && <p className="text-sm text-red-700">Store-server: {error}</p>}
        <Card>
          <CardHeader>
            <CardTitle>Requests</CardTitle>
            <CardDescription>What users asked the agent for. Open a row for the diff and the tool log.</CardDescription>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm" data-testid="admin-requests">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">User</th>
                  <th className="py-2 pr-3 font-medium">Request</th>
                  <th className="py-2 pr-3 font-medium">Verdict</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-muted-foreground">
                      No requests yet. Ask the agent something in the app.
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr
                      className={cn('cursor-pointer border-b border-border align-top hover:bg-muted', open === r.id && 'bg-muted')}
                      onClick={() => setOpen(open === r.id ? null : r.id)}
                      data-testid="admin-row"
                      data-request-id={r.id}
                      data-status={r.status}
                      data-verdict={r.verdict}
                    >
                      <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">{new Date(r.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</td>
                      <td className="py-2 pr-3">{r.userId}</td>
                      <td className="py-2 pr-3">
                        {r.text}
                        <div className="text-xs text-muted-foreground">{r.summary}</div>
                      </td>
                      <td className="py-2 pr-3">
                        <Badge variant={r.verdict === 'ok' ? 'success' : r.verdict === 'needs-backend' ? 'warning' : 'destructive'}>{r.verdict}</Badge>
                      </td>
                      <td className="py-2 pr-3" data-testid="admin-status">
                        <Badge variant={STATUS_VARIANT[r.status] ?? 'secondary'}>{r.status}</Badge>
                        {r.isHead && <span className="ml-1 text-xs text-muted-foreground">live</span>}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{r.provider === 'scripted' ? 'scripted' : `$${cost(r.usage).toFixed(4)}`}</td>
                    </tr>
                    {open === r.id && (
                      <tr>
                        <td colSpan={6} className="border-b border-border bg-background p-4">
                          <RequestDetail id={r.id} call={call} onChanged={load} />
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

function RequestDetail({ id, call, onChanged }: { id: string; call: ReturnType<typeof useAdminApi>; onChanged: () => Promise<void> }) {
  const [d, setD] = useState<Detail | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(() => call<Detail>(`/admin/requests/${id}`).then(setD), [call, id])
  useEffect(() => {
    void load()
  }, [load])

  const act = async (action: 'rollback' | 'reject' | 'approve', label: string) => {
    try {
      await call(`/admin/requests/${id}/${action}`, { method: 'POST', body: '{}' })
      setMsg(label)
      await Promise.all([load(), onChanged()])
    } catch (e) {
      setMsg((e as Error).message)
    }
  }

  if (!d) return <p className="text-sm text-muted-foreground">Loading…</p>
  const r = d.request
  const after = d.snapshot?.files ?? r.files ?? {}
  const before = d.parent?.files ?? {}
  const changed = Object.keys({ ...before, ...after })
    .filter((p) => before[p] !== after[p] && (d.snapshot ? true : p in after))
    .sort()

  return (
    <div className="grid gap-4" data-testid="admin-detail">
      <div className="flex flex-wrap items-center gap-2">
        {r.isHead && (
          <Button size="sm" variant="outline" data-testid="admin-rollback" onClick={() => void act('rollback', 'Rolled back for the user.')}>
            Roll back for {r.userId}
          </Button>
        )}
        {r.status !== 'rejected' && r.status !== 'rolled-back' && (
          <Button size="sm" variant="outline" data-testid="admin-reject" onClick={() => void act('reject', 'Rejected.')}>
            Reject
          </Button>
        )}
        {r.status === 'pending-admin' && (
          <Button size="sm" data-testid="admin-approve" onClick={() => void act('approve', 'Taken into work.')}>
            Take into work
          </Button>
        )}
        {msg && (
          <span className="text-sm text-muted-foreground" data-testid="admin-msg">
            {msg}
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {r.provider}/{r.model} · classified {r.classification ?? '—'} · {r.timings?.totalMs ?? '—'} ms
          {r.usage?.map((u) => ` · ${u.model}: ${u.inputTokens} in / ${u.outputTokens} out / ${u.cacheReadTokens} cached`).join('')}
        </span>
      </div>
      {r.error && <p className="text-sm text-red-700">Browser: {r.error}</p>}

      <div>
        <h4 className="mb-2 text-sm font-semibold">Changes {d.snapshot ? 'vs the previous version' : '(proposed, not applied)'}</h4>
        {changed.length === 0 && <p className="text-sm text-muted-foreground">No file changes.</p>}
        {changed.map((p) => (
          <FileDiff key={p} path={p} before={before[p] ?? ''} after={after[p] ?? ''} />
        ))}
      </div>

      <div>
        <h4 className="mb-2 text-sm font-semibold">Tool log</h4>
        <table className="w-full text-xs" data-testid="admin-log">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="pr-2">#</th>
              <th className="pr-2">Tool</th>
              <th className="pr-2">Input</th>
              <th className="pr-2">Result</th>
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
