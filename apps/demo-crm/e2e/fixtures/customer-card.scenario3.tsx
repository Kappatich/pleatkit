import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { Customer } from '@/readonly/api'
import { formatDate } from '@/readonly/format'

const pill = {
  active: 'bg-emerald-100 text-emerald-800 ring-emerald-600/20',
  lead: 'bg-sky-100 text-sky-800 ring-sky-600/20',
  churned: 'bg-zinc-100 text-zinc-600 ring-zinc-500/20',
} as const

export default function CustomerCard({ customer }: { customer: Customer }) {
  return (
    <Card data-testid="customer-card">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-2xl">{customer.name}</CardTitle>
          <span data-testid="status-pill" className={`rounded-full px-3 py-0.5 text-xs font-medium ring-1 ring-inset ${pill[customer.status]}`}>
            {customer.status}
          </span>
        </div>
        <CardDescription>{customer.email}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Next payment</dt>
          <dd data-testid="due-date">{formatDate(customer.dueDate)}</dd>
        </dl>
      </CardContent>
    </Card>
  )
}
