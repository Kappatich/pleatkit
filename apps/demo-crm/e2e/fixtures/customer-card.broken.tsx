import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import type { Customer } from '@/readonly/api'

export default function CustomerCard({ customer }: { customer: Customer }) {
  return (
    <Card data-testid="customer-card">
      <CardHeader>
        <CardTitle>{customer.name}
      </CardHeader>
    </Card>
  )
}
