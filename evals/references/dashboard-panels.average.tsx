import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { Customer, Deal } from '@/readonly/api'
import { formatMoney } from '@/readonly/format'

export default function DashboardPanels({ customers, deals }: { customers: Customer[]; deals: Deal[] }) {
  const open = deals.filter((d) => d.stage === 'lead' || d.stage === 'proposal')
  const average = deals.length ? deals.reduce((s, d) => s + d.amount, 0) / deals.length : 0
  const panels = [
    { label: 'Customers', value: String(customers.length), hint: `${customers.filter((c) => c.status === 'active').length} active` },
    { label: 'Open pipeline', value: formatMoney(open.reduce((s, d) => s + d.amount, 0)), hint: `${open.length} deals` },
    { label: 'Won', value: formatMoney(deals.filter((d) => d.stage === 'won').reduce((s, d) => s + d.amount, 0)), hint: 'all time' },
    { label: 'Average deal', value: formatMoney(average), hint: `${deals.length} deals`, id: 'average-deal' },
  ]
  return (
    <div className="grid gap-4 sm:grid-cols-4" data-testid="dashboard-panels">
      {panels.map((p) => (
        <Card key={p.label} data-testid={p.id}>
          <CardHeader>
            <CardDescription>{p.label}</CardDescription>
            <CardTitle className="text-2xl">{p.value}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">{p.hint}</CardContent>
        </Card>
      ))}
    </div>
  )
}
