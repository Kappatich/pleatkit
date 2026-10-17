import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { Deal } from '@/readonly/api'
import { formatMoney } from '@/readonly/format'

const stageVariant = { lead: 'secondary', proposal: 'warning', won: 'success', lost: 'destructive' } as const

export default function DealsTable({ deals }: { deals: Deal[] }) {
  return (
    <Card data-testid="deals-table">
      <CardHeader>
        <CardTitle>Deals</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deals.map((deal) => (
              <TableRow key={deal.id}>
                <TableCell>{deal.title}</TableCell>
                <TableCell>
                  <Badge variant={stageVariant[deal.stage]}>{deal.stage}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(deal.amount)}</TableCell>
              </TableRow>
            ))}
            {deals.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="text-muted-foreground">
                  No deals yet
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
