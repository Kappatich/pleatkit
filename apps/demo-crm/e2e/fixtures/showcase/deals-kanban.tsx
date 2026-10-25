import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api, type Customer, type Deal } from '@/readonly/api'
import { formatMoney } from '@/readonly/format'
import './deals-kanban.css'

// The open deals of all customers as a board: one column per pipeline step (meta.step), the cards slide in from
// where the table was one after another, and each column's total counts up once its cards are in.

const STEPS = ['Qualified', 'Demo', 'Proposal', 'Negotiation']
const vars = (v: Record<string, string | number>) => v as CSSProperties
const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()
const text = (v: unknown, fallback = '—') => (typeof v === 'string' && v.trim() ? v : fallback)
const stepOf = (d: Deal) => text(d.meta.step, d.stage === 'lead' ? 'Qualified' : 'Proposal')

function useCountUp(target: number, ms = 800): [number, () => void] {
  const [value, setValue] = useState(0)
  const started = useRef(false)
  const start = () => {
    if (started.current) return
    started.current = true
    const t0 = performance.now()
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / ms)
      setValue(Math.round(target * (1 - Math.pow(1 - p, 3))))
      if (p < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }
  return [reduceMotion() ? target : value, start]
}

function Column({ step, deals, names, first, index }: { step: string; deals: Deal[]; names: Map<string, string>; first: number; index: number }) {
  const total = deals.reduce((s, d) => s + d.amount, 0)
  const [shown, countUp] = useCountUp(total)
  // the total starts counting when the column's last card has landed
  const landed = 0.35 + (first + Math.max(0, deals.length - 1)) * 0.11 + 0.3
  return (
    <section className="kb-col" style={vars({ '--k': index })} data-testid="kanban-column" data-step={step}>
      <header className="kb-head">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-[13px] font-semibold">{step}</h4>
          <span className="kb-count">{deals.length}</span>
        </div>
        <span className="kb-total" style={vars({ '--d': `${landed}s` })} onAnimationStart={countUp} data-testid="column-total">
          {formatMoney(shown)}
        </span>
      </header>
      <ol className="kb-list grid gap-1.5">
        {deals.map((d, i) => {
          const owner = text(d.meta.owner)
          return (
            <li key={d.id} className="kb-card" style={vars({ '--n': first + i })} data-testid="kanban-card">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 text-[13px] font-medium leading-[18px]">{d.title}</span>
                <span className="kb-owner" title={owner}>
                  {initials(owner)}
                </span>
              </div>
              <div className="mt-0.5 flex items-baseline justify-between gap-1.5 text-xs">
                <span className="min-w-0 truncate text-muted-foreground">{names.get(d.customerId) ?? '—'}</span>
                <span className="kb-amount">{formatMoney(d.amount)}</span>
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

export default function DealsTable(_props: { deals: Deal[] }) {
  const [data, setData] = useState<{ deals: Deal[]; customers: Customer[] } | null>(null)
  useEffect(() => {
    let live = true
    Promise.all([api.deals(), api.customers()]).then(
      ([deals, customers]) => live && setData({ deals, customers }),
      () => live && setData({ deals: [], customers: [] }),
    )
    return () => {
      live = false
    }
  }, [])
  const open = (data?.deals ?? []).filter((d) => d.stage === 'lead' || d.stage === 'proposal')
  const names = new Map((data?.customers ?? []).map((c) => [c.id, c.name]))
  let first = 0
  const columns = STEPS.map((step) => {
    const deals = open.filter((d) => stepOf(d) === step).sort((a, b) => b.amount - a.amount)
    const col = { step, deals, first }
    first += deals.length
    return col
  })
  return (
    <Card data-testid="deals-kanban">
      <CardHeader className="flex-row items-end justify-between gap-4">
        <div className="grid gap-1.5">
          <CardTitle>Open deals by stage</CardTitle>
          <CardDescription>All customers, largest first in each column</CardDescription>
        </div>
        {data && (
          <span className="kb-sum text-sm text-muted-foreground">
            {open.length} deals · <b className="font-semibold text-foreground tabular-nums">{formatMoney(open.reduce((s, d) => s + d.amount, 0))}</b>
          </span>
        )}
      </CardHeader>
      <CardContent>
        {data ? (
          <div className="grid grid-cols-4 gap-2">
            {columns.map((c, k) => (
              <Column key={c.step} step={c.step} deals={c.deals} names={names} first={c.first} index={k} />
            ))}
          </div>
        ) : (
          <div className="h-[290px]" />
        )}
      </CardContent>
    </Card>
  )
}
