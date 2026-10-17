// Dynamic zone: the agent may rewrite this panel for the user who asks. Keep the default export.
import { money, type Order } from '@/readonly/api'

export default function OrdersTable({ orders }: { orders: Order[] }) {
  return (
    <table className="w-full text-left text-sm" data-testid="orders-table">
      <thead>
        <tr className="border-b">
          <th className="py-2">Order</th>
          <th className="py-2">Customer</th>
          <th className="py-2">Status</th>
          <th className="py-2 text-right">Total</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id} className={o.status === 'overdue' ? 'border-b bg-red-50 text-red-700' : 'border-b'} data-status={o.status}>
            <td className="py-2">{o.id}</td>
            <td className="py-2">{o.customer}</td>
            <td className="py-2">{o.status}</td>
            <td className="py-2 text-right">{money(o.total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
