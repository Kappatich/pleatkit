import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Locale } from '@pleatkit/runtime'
import type { AdminCall } from './admin-api'
import type { AdminTranslate } from './admin-i18n'

/**
 * The /admin screens beyond the request log (stage 4c block 2): the 4a foundations that had no screen yet: flags,
 * the events feed, the audit chain and the plan with its usage and the expected cost of an edit. Same design v3 as
 * the requests: one H1, one stats line between rules, timetables with mono column labels, red only for what waits on
 * the admin. The pleatkit cloud adds its own screens (the wish map, code search, carry-over runs, the pilot report).
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

/** `POST /agent/v1/expected-cost` (the agent's expected-cost.ts): what this screen reads. */
interface ExpectedCostView {
  model: string
  classifierModel: string | null
  source: 'counted' | 'estimated'
  expectedUsd: number | null
  coldUsd: number | null
  unpriced: string[]
}

/**
 * DECISIONS 75 Р2: the expected cost of an edit on this app, from the agent server. (The measured money of the pilot
 * report, token cost, hours saved and cost per applied edit by organization, is a pleatkit cloud screen.)
 */
function MoneySection({ agent, tr }: Pick<ScreenProps, 'tr'> & { agent?: AdminCall }) {
  const [expected, setExpected] = useState<ExpectedCostView | null>(null)
  const [expectedError, setExpectedError] = useState<string | null>(null)
  useEffect(() => {
    if (!agent) return
    agent<ExpectedCostView>('/expected-cost', { method: 'POST' }).then(setExpected, (e: Error) => setExpectedError(e.message))
  }, [agent])
  const money = (v: number | null | undefined) => (v === null || v === undefined ? '—' : usd(v))
  const value = expected && expected.expectedUsd !== null ? usd(expected.expectedUsd) : '—'
  const note = expected
    ? expected.expectedUsd === null
      ? tr('adm.p.m.expected.none', { reason: expected.unpriced.join(', ') })
      : tr('adm.p.m.expected.note', { model: expected.model, how: tr(expected.source === 'counted' ? 'adm.p.m.counted' : 'adm.p.m.estimated'), cold: money(expected.coldUsd) })
    : tr('adm.p.m.expected.none', { reason: expectedError ?? '…' })
  return (
    <div className="adm-split adm-after" data-testid="admin-plan-money">
      <section>
        <h2 className="adm-h2">{tr('adm.p.money')}</h2>
        <table className="adm-table" data-testid="admin-plan-measures">
          <colgroup>
            <col />
            <col className="adm-w-120" />
          </colgroup>
          <thead>
            <tr>
              <th>{tr('adm.p.col.measure')}</th>
              <th className="adm-r">{tr('adm.p.col.value')}</th>
            </tr>
          </thead>
          <tbody>
            <tr className="adm-line" data-testid="admin-plan-expected" {...(expected ? { 'data-source': expected.source } : {})}>
              <td>
                <span className="adm-text">{tr('adm.p.m.expected')}</span>
                <span className="adm-quote">{note}</span>
              </td>
              <td className="adm-cost" data-testid="admin-plan-expected-value">
                {value}
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  )
}

export function PlanScreen({ call, agent, tr, locale }: ScreenProps & { agent?: AdminCall }) {
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
    const by = new Map<string, { requests: number; applied: number; editors: number; cost: number; rateLimited: number }>()
    for (let i = 6; i >= 0; i--) by.set(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10), { requests: 0, applied: 0, editors: 0, cost: 0, rateLimited: 0 })
    for (const e of events) {
      const d = by.get(e.ts.slice(0, 10))
      if (!d) continue
      if (e.type === 'edit.requested') d.requests++
      if (e.type === 'edit.applied') d.applied++
      if (e.type === 'editor.active') d.editors++
      if (e.type === 'cost.usd') d.cost += e.value
      // stage 5 block 3: runs the model provider's rate limit stopped
      if (e.type === 'edit.rate_limited') d.rateLimited++
    }
    return [...by.entries()].reverse()
  }, [events])
  const t = days.find(([d]) => d === today)?.[1] ?? { requests: 0, applied: 0, editors: 0, cost: 0, rateLimited: 0 }
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
                <col />
                <col className="adm-w-92" />
              </colgroup>
              <thead>
                <tr>
                  <th>{tr('adm.p.col.day')}</th>
                  <th className="adm-r">{tr('adm.p.col.requests')}</th>
                  <th className="adm-r">{tr('adm.p.col.applied')}</th>
                  <th className="adm-r">{tr('adm.p.col.editors')}</th>
                  <th className="adm-r">{tr('adm.p.col.rateLimited')}</th>
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
                    <td className="adm-cost" data-testid="admin-plan-rate-limited">{x.rateLimited}</td>
                    <td className="adm-cost">{usd(x.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      <MoneySection agent={agent} tr={tr} />
      <p className="adm-foot">{tr('adm.p.foot')}</p>
    </>
  )
}
