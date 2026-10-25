import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api, type Deal } from '@/readonly/api'
import { formatMoney } from '@/readonly/format'
import './pipeline-pivot.css'

// The open pipeline as a pivot: regions (meta.region) and their owners (meta.owner) down, the lead and proposal
// stages across, a subtotal per region and the grand total last. The groups open one after another.

const REGIONS = ['North America', 'Europe', 'Asia Pacific']
const vars = (v: Record<string, string | number>) => v as CSSProperties
const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : 'Unassigned')

interface Sums {
  lead: number
  proposal: number
  count: number
}
const empty = (): Sums => ({ lead: 0, proposal: 0, count: 0 })
function add(s: Sums, d: Deal): void {
  if (d.stage === 'lead') s.lead += d.amount
  else s.proposal += d.amount
  s.count++
}

function useCountUp(target: number, ms = 900): [number, () => void] {
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

const money = (v: number) => (v ? formatMoney(v) : '—')

function Cells({ s, total }: { s: Sums; total?: string }) {
  return (
    <>
      <td className={s.lead ? 'pv-num' : 'pv-num pv-none'}>{money(s.lead)}</td>
      <td className={s.proposal ? 'pv-num' : 'pv-num pv-none'}>{money(s.proposal)}</td>
      <td className="pv-num pv-strong">{total ?? formatMoney(s.lead + s.proposal)}</td>
      <td className="pv-num pv-count">{s.count}</td>
    </>
  )
}

function Pivot({ deals }: { deals: Deal[] }) {
  const open = deals.filter((d) => d.stage === 'lead' || d.stage === 'proposal')
  const regions = [...REGIONS, ...new Set(open.map((d) => text(d.meta.region)).filter((r) => !REGIONS.includes(r)))]
    .map((region) => {
      const inRegion = open.filter((d) => text(d.meta.region) === region)
      const owners = new Map<string, Sums>()
      const sub = empty()
      for (const d of inRegion) {
        const owner = text(d.meta.owner)
        if (!owners.has(owner)) owners.set(owner, empty())
        add(owners.get(owner)!, d)
        add(sub, d)
      }
      const rows = [...owners].sort((a, b) => b[1].lead + b[1].proposal - (a[1].lead + a[1].proposal))
      return { region, rows, sub }
    })
    .filter((g) => g.rows.length > 0)
  const grand = empty()
  open.forEach((d) => add(grand, d))
  const grandTotal = grand.lead + grand.proposal
  const [shown, countUp] = useCountUp(grandTotal)
  const GROUP = 0.62
  const start = 0.3
  const last = start + regions.length * GROUP + 0.05

  return (
    <table className="pv-table w-full">
      <thead>
        <tr className="pv-head">
          <th className="text-left">Region</th>
          <th className="text-left">Owner</th>
          <th>Lead</th>
          <th>Proposal</th>
          <th>Total</th>
          <th>Deals</th>
        </tr>
      </thead>
      <tbody>
        {regions.map((g, gi) => {
          const at = start + gi * GROUP
          return [
            ...g.rows.map(([owner, s], i) => (
              <tr key={`${g.region}:${owner}`} className="pv-row" style={vars({ '--d': `${at + 0.12 + i * 0.12}s` })} data-testid="pivot-row" data-region={g.region} data-owner={owner}>
                {i === 0 && (
                  <th rowSpan={g.rows.length + 1} scope="rowgroup" className="pv-region" style={vars({ '--d': `${at}s` })}>
                    <span className="pv-chevron" aria-hidden="true" />
                    {g.region}
                  </th>
                )}
                <td className="pv-owner">{owner}</td>
                <Cells s={s} />
              </tr>
            )),
            <tr key={`${g.region}:subtotal`} className="pv-sub" style={vars({ '--d': `${at + 0.16 + g.rows.length * 0.12}s` })} data-testid="pivot-subtotal" data-region={g.region}>
              <td className="pv-owner">Subtotal</td>
              <Cells s={g.sub} />
            </tr>,
          ]
        })}
        <tr className="pv-grand" style={vars({ '--d': `${last}s` })} onAnimationStart={countUp} data-testid="pivot-grand-total">
          <th colSpan={2} className="text-left">
            Grand total
          </th>
          <Cells s={grand} total={formatMoney(shown)} />
        </tr>
      </tbody>
    </table>
  )
}

export default function DealsTable(_props: { deals: Deal[] }) {
  const [deals, setDeals] = useState<Deal[] | null>(null)
  useEffect(() => {
    let live = true
    api.deals().then(
      (all) => live && setDeals(all),
      () => live && setDeals([]),
    )
    return () => {
      live = false
    }
  }, [])
  return (
    <Card data-testid="pipeline-pivot">
      <CardHeader className="pb-2">
        <CardTitle>Pipeline by region and owner</CardTitle>
        <CardDescription>Open deals of all customers, by stage</CardDescription>
      </CardHeader>
      <CardContent>{deals ? <Pivot deals={deals} /> : <div className="h-[330px]" />}</CardContent>
    </Card>
  )
}
