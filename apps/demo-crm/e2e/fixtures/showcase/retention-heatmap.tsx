import { useEffect, useState, type CSSProperties } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api, type Cohort, type Customer, type Deal } from '@/readonly/api'
import { formatMoney } from '@/readonly/format'
import './retention-heatmap.css'

// The dashboard keeps its three numbers, stacked on the left, and gets a retention heatmap: one row per signup
// cohort, one column per month after signup, the share of accounts still paying. Paper at 50 % and below, red at 100 %.

const MONTHS = 6
const vars = (v: Record<string, string | number>) => v as CSSProperties
const cohortLabel = (month: string) => new Date(`${month}-01T00:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })

/** 50 % or less is paper, 100 % is the app's red; the colour is mixed in the browser so the dark theme works too. */
function shade(share: number): { background: string; strong: boolean } {
  const t = Math.round(Math.min(1, Math.max(0, (share - 0.5) / 0.5)) * 100)
  return { background: `color-mix(in oklab, var(--destructive) ${t}%, var(--card))`, strong: t > 68 }
}

function Heatmap({ cohorts }: { cohorts: Cohort[] }) {
  const firstMonth = cohorts.map((c) => c.active[1]! / c.active[0]!).filter((x) => Number.isFinite(x))
  const avg = firstMonth.length ? Math.round((firstMonth.reduce((s, x) => s + x, 0) / firstMonth.length) * 100) : 0
  return (
    <div className="hm-grid" role="table" aria-label="Retention by signup cohort">
      <div role="row" className="contents">
        <span role="columnheader" className="hm-head hm-head-left hm-fade" style={vars({ '--d': '0s' })}>
          Cohort
        </span>
        <span role="columnheader" className="hm-head hm-fade" style={vars({ '--d': '.05s' })}>
          Signups
        </span>
        {Array.from({ length: MONTHS }, (_, m) => (
          <span key={m} role="columnheader" className="hm-head hm-fade" style={vars({ '--d': `${0.1 + m * 0.05}s` })}>
            Month {m + 1}
          </span>
        ))}
      </div>
      {cohorts.map((c, r) => (
        <div key={c.month} role="row" className="contents" data-testid="cohort-row" data-cohort={c.month}>
          <span role="rowheader" className="hm-label hm-fade" style={vars({ '--d': `${0.15 + r * 0.07}s` })}>
            {cohortLabel(c.month)}
          </span>
          <span role="cell" className="hm-size hm-fade" style={vars({ '--d': `${0.2 + r * 0.07}s` })}>
            {c.active[0]}
          </span>
          {Array.from({ length: MONTHS }, (_, m) => {
            const kept = c.active[m + 1]
            const order = vars({ '--r': r, '--c': m })
            if (kept === undefined) return <span key={m} role="cell" className="hm-cell hm-empty" style={order} />
            const share = kept / c.active[0]!
            const { background, strong } = shade(share)
            return (
              <span
                key={m}
                role="cell"
                data-testid="retention-cell"
                data-share={Math.round(share * 100)}
                title={`${kept} of ${c.active[0]} accounts still paying`}
                className="hm-cell"
                style={{ ...order, background }}
              >
                <b className={strong ? 'hm-num hm-num-strong' : 'hm-num'}>{Math.round(share * 100)}%</b>
              </span>
            )
          })}
        </div>
      ))}
      <p className="hm-note hm-fade" style={vars({ '--d': '1.7s' })}>
        Month 1 keeps <b data-testid="month-one-retention">{avg}%</b> of new accounts on average; newer cohorts stay longer.
      </p>
    </div>
  )
}

export default function DashboardPanels({ customers, deals }: { customers: Customer[]; deals: Deal[] }) {
  const [cohorts, setCohorts] = useState<Cohort[] | null>(null)
  useEffect(() => {
    let live = true
    api.cohorts().then(
      (c) => live && setCohorts(c),
      () => live && setCohorts([]),
    )
    return () => {
      live = false
    }
  }, [])
  const open = deals.filter((d) => d.stage === 'lead' || d.stage === 'proposal')
  const panels = [
    { label: 'Customers', value: String(customers.length), hint: `${customers.filter((c) => c.status === 'active').length} active` },
    { label: 'Open pipeline', value: formatMoney(open.reduce((s, d) => s + d.amount, 0)), hint: `${open.length} deals` },
    { label: 'Won', value: formatMoney(deals.filter((d) => d.stage === 'won').reduce((s, d) => s + d.amount, 0)), hint: 'all time' },
  ]
  return (
    <div className="hm-layout" data-testid="dashboard-panels">
      <div className="hm-kpis grid content-start gap-4">
        {panels.map((p) => (
          <Card key={p.label}>
            <CardHeader className="pb-4">
              <CardDescription>{p.label}</CardDescription>
              <CardTitle className="text-2xl">{p.value}</CardTitle>
              <span className="text-xs text-muted-foreground">{p.hint}</span>
            </CardHeader>
          </Card>
        ))}
      </div>
      <Card data-testid="retention-heatmap" className="hm-card">
        <CardHeader className="flex-row items-start justify-between gap-6">
          <div className="grid gap-1.5">
            <CardTitle>Retention by signup cohort</CardTitle>
            <CardDescription>Share of the accounts that signed up in a month and still pay N months later</CardDescription>
          </div>
          <div className="hm-legend hm-fade shrink-0" style={vars({ '--d': '.2s' })} aria-hidden="true">
            <span>50%</span>
            <i />
            <span>100%</span>
          </div>
        </CardHeader>
        <CardContent>{cohorts ? <Heatmap cohorts={cohorts} /> : <div className="h-[300px]" />}</CardContent>
      </Card>
    </div>
  )
}
