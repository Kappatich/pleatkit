export type Meta = Record<string, unknown>

export interface Customer {
  id: string
  name: string
  email: string
  status: 'lead' | 'active' | 'churned'
  /** ISO date (yyyy-mm-dd) of the next payment or follow-up */
  dueDate: string
  /** Generic key-value fields, so simple UI features need no backend change. */
  meta: Meta
}

export interface Deal {
  id: string
  customerId: string
  title: string
  amount: number
  stage: 'lead' | 'proposal' | 'won' | 'lost'
  meta: Meta
}

const day = 24 * 60 * 60 * 1000
const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10)

/** Dates are relative to server start so "overdue" stays meaningful whenever the demo runs. */
export function seed(): { customers: Customer[]; deals: Deal[] } {
  const customers: Customer[] = [
    { id: 'c1', name: 'Globex Corporation', email: 'hank@globex.example', status: 'active', dueDate: isoDay(-6), meta: { phone: '+1 555 0102', city: 'Springfield', source: 'Referral' } },
    { id: 'c2', name: 'Initech', email: 'bill@initech.example', status: 'active', dueDate: isoDay(12), meta: { phone: '+1 555 0147', city: 'Austin', source: 'Website' } },
    { id: 'c3', name: 'Umbrella Health', email: 'ops@umbrella.example', status: 'lead', dueDate: isoDay(-1), meta: { phone: '+44 20 7946 0958', city: 'London', source: 'Conference' } },
    { id: 'c4', name: 'Stark Logistics', email: 'pepper@stark.example', status: 'churned', dueDate: isoDay(30), meta: { city: 'New York', source: 'Cold email' } },
  ]
  const deals: Deal[] = [
    { id: 'd1', customerId: 'c1', title: 'Annual licence', amount: 48000, stage: 'won', meta: {} },
    { id: 'd2', customerId: 'c1', title: 'Support upgrade', amount: 9500, stage: 'proposal', meta: {} },
    { id: 'd3', customerId: 'c2', title: 'Pilot', amount: 12000, stage: 'lead', meta: {} },
    { id: 'd4', customerId: 'c3', title: 'Clinic rollout', amount: 76000, stage: 'proposal', meta: {} },
    { id: 'd5', customerId: 'c4', title: 'Fleet tracking', amount: 31000, stage: 'lost', meta: {} },
  ]
  return { customers, deals }
}
