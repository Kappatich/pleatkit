import { useCallback, useEffect, useRef, useState } from 'react'
import type { Locale } from '@pleatkit/runtime'
import type { AdminCall } from './admin-api'
import type { AdminTranslate } from './admin-i18n'
import { TimeCell } from './AdminScreens'

/**
 * DECISIONS 81: the Labels screen. One request at a time, the classifier's suggestion marked on its button; one tap
 * (or the digits 1–7) stores the label and moves on; ← → or K J move without labelling. The labels where the person
 * disagrees with the classifier go into the classifier eval (`pleatkit labels export`). DECISIONS 84.2: the seventh
 * button is `restore` ("put it back like it was", the classifier label of 82.2).
 */
const LABELS = ['ui', 'needs-backend', 'clarify', 'off-topic', 'declined', 'mixed', 'restore'] as const
type Label = (typeof LABELS)[number]
type Filter = 'unlabelled' | 'all' | 'disagreements'
const FILTERS: Filter[] = ['unlabelled', 'all', 'disagreements']

interface Item {
  id: string
  userId: string
  text: string
  target: string | null
  createdAt: string
  verdict: string
  status: string
  classification: string | null
  intentLabel: string | null
  suggested: Label | null
  label: Label | null
  labeledAt: string | null
}
interface Counts {
  total: number
  labelled: number
  left: number
  today: number
  disagreements: number
}
interface PageView {
  items: Item[]
  next: string | null
  counts: Counts
  recent: Item[]
}

type K = Parameters<AdminTranslate>[0]
const PAGE = 30
/** Local midnight: "today" in the counter is the labeller's day. */
const since = () => new Date(new Date().setHours(0, 0, 0, 0)).getTime()
const hm = (iso: string, locale: Locale) => new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const day = (iso: string, locale: Locale) => new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: 'short' })

export function LabelsScreen({ call, tr, locale }: { call: AdminCall; tr: AdminTranslate; locale: Locale }) {
  const [filter, setFilter] = useState<Filter>('unlabelled')
  const [items, setItems] = useState<Item[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [at, setAt] = useState(0)
  const [counts, setCounts] = useState<Counts | null>(null)
  const [recent, setRecent] = useState<Item[]>([])
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)

  const page = useCallback((f: Filter, cursor: string | null) => call<PageView>(`/admin/labels?filter=${f}&limit=${PAGE}&since=${since()}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`), [call])

  useEffect(() => {
    let live = true
    setItems(null)
    setAt(0)
    page(filter, null).then(
      (p) => {
        if (!live) return
        setItems(p.items)
        setNext(p.next)
        setCounts(p.counts)
        setRecent(p.recent)
        setError(null)
      },
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [filter, page])

  const move = useCallback(
    async (to: number) => {
      if (!items) return
      let all = items
      // the end of what is loaded: fetch the next page first
      if (to >= items.length && next) {
        try {
          const p = await page(filter, next)
          all = [...items, ...p.items]
          setItems(all)
          setNext(p.next)
          setCounts(p.counts)
        } catch (e) {
          setError((e as Error).message)
          return
        }
      }
      // one step past the last item is the end ("nothing left")
      setAt(Math.min(Math.max(0, to), all.length))
    },
    [items, next, page, filter],
  )

  const label = useCallback(
    async (l: Label) => {
      const item = items?.[at]
      if (!item || busy.current) return
      busy.current = true
      try {
        const r = await call<{ item: Item; counts: Counts; recent: Item[] }>('/admin/labels', { method: 'POST', body: JSON.stringify({ requestId: item.id, label: l, since: since() }) })
        setItems((xs) => xs && xs.map((x) => (x.id === r.item.id ? r.item : x)))
        setCounts(r.counts)
        setRecent(r.recent)
        setMsg(tr('adm.l.saved', { label: tr(`adm.l.label.${l}` as K) }))
        // the next card starts without a focus ring left on the button just pressed
        if (document.activeElement instanceof HTMLElement && document.activeElement.closest('.adm-lb-btns')) document.activeElement.blur()
        setError(null)
        await move(at + 1)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        busy.current = false
      }
    },
    [items, at, call, tr, move],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return
      const n = Number(e.key)
      if (Number.isInteger(n) && n >= 1 && n <= LABELS.length) {
        e.preventDefault()
        void label(LABELS[n - 1]!)
      } else if (e.key === 'ArrowRight' || e.key === 'j' || e.key === 'J') {
        e.preventDefault()
        void move(at + 1)
      } else if (e.key === 'ArrowLeft' || e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        void move(at - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [label, move, at])

  const item = items?.[at] ?? null
  const d = counts?.disagreements ?? 0
  const loaded = items?.length ?? 0
  // the length of the queue: what was labelled here plus what is left; every request; the disagreements
  const queue = filter === 'unlabelled' ? (items ?? []).filter((x) => x.label).length + (counts?.left ?? 0) : filter === 'all' ? (counts?.total ?? loaded) : Math.max(loaded, d)
  return (
    <>
      <h1 className="adm-h1">{tr('adm.l.title')}</h1>
      <div className="adm-stats">
        <p className="adm-week" data-testid="admin-labels-stats">
          {tr('adm.l.today')}{' '}
          <b className="adm-num" data-testid="admin-labels-today">
            {counts?.today ?? 0}
          </b>{' '}
          {tr('adm.l.labelled')}
          <span className="adm-sep"> · </span>
          <b className="adm-num" data-testid="admin-labels-left">
            {counts?.left ?? 0}
          </b>{' '}
          {tr('adm.l.left')}
          <span className="adm-sep"> · </span>
          <b className={d > 0 ? 'adm-num adm-redword' : 'adm-num'} data-testid="admin-labels-disagreements">
            {d}
          </b>{' '}
          {tr(d === 1 ? 'adm.l.disagreements.one' : 'adm.l.disagreements')}
        </p>
        <div className="adm-seg" role="group" aria-label={tr('adm.l.filter')} data-testid="admin-labels-filter">
          {FILTERS.map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} data-testid={`admin-labels-filter-${f}`} onClick={() => setFilter(f)}>
              {tr(`adm.l.filter.${f}` as K)}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="adm-error">Store-server: {error}</p>}

      {items && !item && (
        <p className="adm-lb-done" data-testid="admin-labels-empty">
          {tr(filter === 'disagreements' ? 'adm.l.done.disagreements' : filter === 'all' ? 'adm.l.end' : 'adm.l.done')}
        </p>
      )}
      {item && (
        <section className="adm-lb-card" data-testid="admin-label-card" data-request-id={item.id} data-suggested={item.suggested ?? ''} data-label={item.label ?? ''}>
          <p className="adm-lb-meta">
            <span>
              <b>{hm(item.createdAt, locale)}</b> {day(item.createdAt, locale)}
              <span className="adm-sep"> · </span>
              {item.userId}
              {item.target && (
                <>
                  <span className="adm-sep"> · </span>
                  {item.target}
                </>
              )}
              <span className="adm-sep"> · </span>
              {tr('adm.l.agent', { verdict: item.verdict })}
            </span>
            <span data-testid="admin-label-pos">{tr('adm.l.pos', { i: at + 1, n: Math.max(queue, at + 1) })}</span>
          </p>
          <p className="adm-lb-text" data-testid="admin-label-text">
            {item.text}
          </p>
          <p className="adm-lb-suggest" title={tr('adm.l.suggests.tip')} data-testid="admin-label-suggestion">
            {item.suggested ? (
              <>
                <span className="adm-lb-sq" aria-hidden="true" />
                {tr('adm.l.suggests')}: <b>{tr(`adm.l.label.${item.suggested}` as K)}</b>
                {/* a restore verdict is suggested without a classification (DECISIONS 84.2): no empty brackets */}
                {item.classification && (
                  <span className="adm-dim">
                    {' '}
                    ({item.classification}
                    {item.intentLabel ? ` / ${item.intentLabel}` : ''})
                  </span>
                )}
              </>
            ) : (
              <span className="adm-dim">
                {tr('adm.l.suggests.none')}
                {item.classification ? ` (${tr('adm.l.suggests.raw', { label: item.classification })})` : ''}
              </span>
            )}
          </p>
          <div className="adm-lb-btns" role="group" aria-label={tr('adm.l.title')}>
            {LABELS.map((l, i) => (
              <button
                key={l}
                type="button"
                className="adm-lb-btn"
                data-testid={`admin-label-btn-${l}`}
                data-suggested={item.suggested === l ? 'true' : undefined}
                aria-pressed={item.label === l}
                aria-keyshortcuts={String(i + 1)}
                onClick={() => void label(l)}
              >
                <span className="adm-lb-key">{i + 1}</span>
                {item.suggested === l && <span className="adm-lb-tag">{tr('adm.l.suggested')}</span>}
                {item.label === l && item.suggested !== l && <span className="adm-lb-tag adm-lb-tag-you">{tr('adm.l.yours')}</span>}
                <span className="adm-lb-name">{tr(`adm.l.label.${l}` as K)}</span>
                <span className="adm-lb-hint">{tr(`adm.l.hint.${l}` as K)}</span>
              </button>
            ))}
          </div>
          <div className="adm-lb-nav">
            <button type="button" className="adm-btn adm-btn-quiet" data-testid="admin-label-prev" disabled={at === 0} onClick={() => void move(at - 1)}>
              {tr('adm.l.prev')}
            </button>
            <button type="button" className="adm-btn adm-btn-quiet" data-testid="admin-label-next" onClick={() => void move(at + 1)}>
              {tr('adm.l.next')}
            </button>
            <span className="adm-dim">{tr('adm.l.keys')}</span>
            {msg && (
              <span className="adm-msg" data-testid="admin-label-msg">
                {msg}
              </span>
            )}
          </div>
        </section>
      )}

      <h2 className="adm-h2 adm-lb-h2">{tr('adm.l.recent')}</h2>
      <div className="adm-scroll">
        <table className="adm-table" data-testid="admin-label-recent">
          <colgroup>
            <col className="adm-w-92" />
            <col />
            <col className="adm-w-160" />
            <col className="adm-w-196" />
          </colgroup>
          <thead>
            <tr>
              <th>{tr('adm.col.time')}</th>
              <th>{tr('adm.l.col.request')}</th>
              <th>{tr('adm.l.col.label')}</th>
              <th>{tr('adm.l.col.suggested')}</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 && (
              <tr>
                <td colSpan={4} className="adm-empty">
                  {tr('adm.l.recent.none')}
                </td>
              </tr>
            )}
            {recent.map((r) => {
              const differs = Boolean(r.label && r.suggested && r.label !== r.suggested)
              return (
                <tr key={r.id} className="adm-line" data-testid="admin-label-row" data-request-id={r.id} data-label={r.label ?? ''} data-disagreement={differs ? 'true' : 'false'}>
                  <TimeCell iso={r.labeledAt} locale={locale} />
                  <td>
                    <span className="adm-text adm-lb-clip">{r.text}</span>
                  </td>
                  <td className="adm-outcome">
                    <span className="adm-otext">{r.label ? tr(`adm.l.label.${r.label}` as K) : '—'}</span>
                  </td>
                  <td className="adm-outcome">
                    <span className={differs ? 'adm-mark adm-redword' : 'adm-mark'} aria-hidden="true">
                      {r.suggested ? (differs ? '≠' : '=') : '·'}
                    </span>
                    <span className={differs ? 'adm-otext adm-redword' : 'adm-otext adm-dim'}>{r.suggested ? tr(`adm.l.label.${r.suggested}` as K) : '—'}</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="adm-foot">
        {tr('adm.l.foot')} <code className="adm-mono">pleatkit labels export --store &lt;url&gt; --app &lt;id&gt;</code>
        <span className="adm-sep"> → </span>
        <code className="adm-mono">pnpm eval:classify -- --probes evals/probes/human-disagreements.json</code>
      </p>
    </>
  )
}
