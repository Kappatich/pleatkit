import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { Customer } from '@/readonly/api'
import { daysUntil, formatDate } from '@/readonly/format'
import { cn } from '@/lib/utils'

const statusVariant = { active: 'success', lead: 'warning', churned: 'secondary' } as const

function field(meta: Customer['meta'], key: string): string {
  const value = meta[key]
  return typeof value === 'string' && value.trim() ? value : '—'
}

export default function CustomerCard({ customer }: { customer: Customer }) {
  const overdue = daysUntil(customer.dueDate) < 0
  return (
    <Card data-testid="customer-card">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{customer.name}</CardTitle>
          <Badge variant={statusVariant[customer.status]}>{customer.status}</Badge>
        </div>
        <CardDescription>{customer.email}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Phone</dt>
          <dd data-testid="phone">{field(customer.meta, 'phone')}</dd>
          <dt className="text-muted-foreground">City</dt>
          <dd data-testid="city">{field(customer.meta, 'city')}</dd>
          <dt className="text-muted-foreground">Source</dt>
          <dd data-testid="source">{field(customer.meta, 'source')}</dd>
          <dt className="text-muted-foreground">Next payment</dt>
          <dd data-testid="due-date" data-overdue={overdue} className={cn(overdue && 'font-semibold text-red-600')}>
            {formatDate(customer.dueDate)}
            {overdue && (
              <span data-testid="overdue-chip" className="ml-2 rounded-[3px] bg-red-50 px-[6px] py-px text-[11px] font-semibold uppercase tracking-wide">
                overdue
              </span>
            )}
          </dd>
        </dl>
      </CardContent>
    </Card>
  )
}
