import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api, type Deal } from '@/readonly/api'
import { formatMoney } from '@/readonly/format'
import './revenue-chart.css'

// Revenue by month from the won deals of all customers (their close date is in meta.closedOn), the last twelve
// complete months, a linear-trend forecast for the next three and the best month marked.

const W = 760
const H = 292
const LEFT = 52
const RIGHT = 12
const TOP = 40
const BASE = 262
const SLOTS = 15
const SLOT = (W - LEFT - RIGHT) / SLOTS
const BAR = 26

interface Month {
  key: string
  label: string
  value: number
}

const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

function monthsAround(): { past: Month[]; next: Month[] } {
  const now = new Date()
  const at = (offset: number): Month => {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1)
    return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString('en-US', { month: 'short' }), value: 0 }
  }
  return { past: Array.from({ length: 12 }, (_, i) => at(i - 12)), next: [at(0), at(1), at(2)] }
}

/** Least-squares line through the months, continued for `ahead` more. */
function trend(values: number[], ahead: number): number[] {
  const n = values.length
  const mx = (n - 1) / 2
  const my = values.reduce((s, v) => s + v, 0) / n
  let num = 0
  let den = 0
  values.forEach((v, x) => {
    num += (x - mx) * (v - my)
    den += (x - mx) ** 2
  })
  const slope = den ? num / den : 0
  return Array.from({ length: ahead }, (_, k) => Math.max(0, Math.round(my + slope * (n + k - mx))))
}

/** Counts up to `target` once `start` is called (at once when the user prefers reduced motion). */
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

const vars = (v: Record<string, string | number>) => v as CSSProperties
const short = (v: number) => (v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`)

function Chart({ deals }: { deals: Deal[] }) {
  const { past, next } = monthsAround()
  for (const d of deals) {
    const closed = d.meta.closedOn
    if (d.stage !== 'won' || typeof closed !== 'string') continue
    const m = past.find((x) => closed.startsWith(x.key))
    if (m) m.value += d.amount
  }
  const forecast = trend(
    past.map((m) => m.value),
    3,
  ).map((value, i) => ({ ...next[i]!, value }))
  const best = past.reduce((b, m) => (m.value > b.value ? m : b), past[0]!)
  const total = past.reduce((s, m) => s + m.value, 0)
  const top = Math.max(50_000, Math.ceil(Math.max(...past.map((m) => m.value), ...forecast.map((m) => m.value)) / 50_000) * 50_000)
  const y = (v: number) => BASE - (v / top) * (BASE - TOP)
  const cx = (i: number) => LEFT + SLOT * i + SLOT / 2
  const grid = Array.from({ length: top / 50_000 + 1 }, (_, i) => i * 50_000)
  const last = past.length - 1
  const line = [[cx(last), y(past[last]!.value)], ...forecast.map((m, i) => [cx(12 + i), y(m.value)])].map((p) => p.join(',')).join(' ')
  const bestIndex = past.indexOf(best)
  const [shown, countUp] = useCountUp(best.value)

  return (
    <>
      <div className="mb-1 flex items-baseline justify-between gap-4 text-sm">
        <span className="rc-fade text-muted-foreground" style={vars({ '--d': '.1s' })}>
          Last 12 months <b data-testid="revenue-total" className="ml-1 font-semibold text-foreground tabular-nums">{formatMoney(total)}</b>
        </span>
        <span className="rc-fade flex items-center gap-4 text-xs text-muted-foreground" style={vars({ '--d': '.2s' })}>
          <span className="flex items-center gap-1.5"><i className="rc-key" />Won</span>
          <span className="flex items-center gap-1.5"><i className="rc-key rc-key-best" />Best month</span>
          <span className="flex items-center gap-1.5"><i className="rc-key rc-key-fc" />Forecast</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`Revenue by month; best month ${best.label}, ${formatMoney(best.value)}`}>
        <rect className="rc-fc-zone rc-fade" style={vars({ '--d': '1.25s' })} x={LEFT + SLOT * 12 + 2} y={TOP - 26} width={SLOT * 3 - 4} height={BASE - TOP + 26} rx="6" />
        <text className="rc-fc-title rc-fade" style={vars({ '--d': '1.35s' })} x={LEFT + SLOT * 13.5} y={TOP - 10}>
          FORECAST
        </text>
        {grid.map((v, i) => (
          <g key={v}>
            <line className={v === 0 ? 'rc-axis' : 'rc-grid'} style={vars({ '--i': i })} x1={LEFT} x2={W - RIGHT} y1={y(v)} y2={y(v)} pathLength={1} />
            <text className="rc-tick rc-fade" style={vars({ '--d': `${0.15 + i * 0.09}s` })} x={LEFT - 10} y={y(v) + 4}>
              {short(v)}
            </text>
          </g>
        ))}
        {past.map((m, i) => (
          <g key={m.key}>
            <rect
              data-testid="revenue-bar"
              data-month={m.key}
              className={i === bestIndex ? 'rc-bar rc-bar-best' : 'rc-bar'}
              style={vars({ '--i': i })}
              x={cx(i) - BAR / 2}
              y={y(m.value)}
              width={BAR}
              height={BASE - y(m.value)}
              rx="3"
            />
            <text className="rc-month rc-fade" style={vars({ '--d': `${0.4 + i * 0.06}s` })} x={cx(i)} y={BASE + 20}>
              {m.label}
            </text>
          </g>
        ))}
        {forecast.map((m, i) => (
          <text key={m.key} className="rc-month rc-month-fc rc-fade" style={vars({ '--d': `${1.3 + i * 0.08}s` })} x={cx(12 + i)} y={BASE + 20}>
            {m.label}
          </text>
        ))}
        <polyline data-testid="revenue-forecast" className="rc-forecast" points={line} pathLength={98} />
        {forecast.map((m, i) => (
          <g key={m.key} className="rc-dot" style={vars({ '--i': i })}>
            <circle cx={cx(12 + i)} cy={y(m.value)} r="4.5" />
            <text className="rc-fc-value" x={cx(12 + i)} y={y(m.value) - 12} data-testid="forecast-value">
              {short(m.value)}
            </text>
          </g>
        ))}
        <g className="rc-label" onAnimationStart={countUp}>
          <text className="rc-best-value" x={cx(bestIndex)} y={y(best.value) - 24} data-testid="best-month" data-month={best.key}>
            {formatMoney(shown)}
          </text>
          <text className="rc-best-note" x={cx(bestIndex)} y={y(best.value) - 10}>
            best month · {best.label}
          </text>
        </g>
      </svg>
    </>
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
    <Card data-testid="revenue-chart" className="rc-card">
      <CardHeader>
        <CardTitle>Revenue by month</CardTitle>
        <CardDescription>Won deals of all customers, with a forecast for the next three months</CardDescription>
      </CardHeader>
      <CardContent>{deals ? <Chart deals={deals} /> : <div className="h-[320px]" />}</CardContent>
    </Card>
  )
}
