// Readonly zone: the agent reads this file and imports it as `@/readonly/api`, but never changes it.

export interface Order {
  id: string
  customer: string
  total: number
  status: 'paid' | 'open' | 'overdue'
  /** Free-form extra fields: the agent can show them without any backend change. */
  meta: Record<string, unknown>
}

export const orders: Order[] = [
  { id: 'A-1001', customer: 'Globex', total: 1250, status: 'paid', meta: { channel: 'web' } },
  { id: 'A-1002', customer: 'Initech', total: 480, status: 'overdue', meta: { channel: 'phone' } },
  { id: 'A-1003', customer: 'Umbrella', total: 2990, status: 'open', meta: { channel: 'web' } },
]

export const money = (n: number): string => `$${n.toLocaleString('en-US')}`
