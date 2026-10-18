import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { Customer } from '@/readonly/api'
import { formatDate } from '@/readonly/format'

const statusVariant = { active: 'success', lead: 'warning', churned: 'secondary' } as const

export default function CustomerCard({ customer }: { customer: Customer }) {
  const phone = typeof customer.meta.phone === 'string' && customer.meta.phone.trim() ? customer.meta.phone : '—'
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
          <dd data-testid="phone">{phone}</dd>
          <dt className="text-muted-foreground">Next payment</dt>
          <dd data-testid="due-date">{formatDate(customer.dueDate)}</dd>
        </dl>
      </CardContent>
    </Card>
  )
}
