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

/** Accounts that signed up in one month, and how many of them were still paying in each month after it. */
export interface Cohort {
  /** yyyy-mm of the signup month */
  month: string
  /** active[0]: accounts that signed up; active[n]: accounts still paying n months later (complete months only) */
  active: number[]
}

const day = 24 * 60 * 60 * 1000
const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10)
const pad = (n: number) => String(n).padStart(2, '0')
/** yyyy-mm-dd of `dayOfMonth` in the month `offset` months from the current one (local time). */
function inMonth(offset: number, dayOfMonth: number): string {
  const now = new Date()
  const d = new Date(now.getFullYear(), now.getMonth() + offset, dayOfMonth)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const monthOf = (offset: number) => inMonth(offset, 1).slice(0, 7)

// Who sells where: every deal has an owner and the region it is sold in; open deals also have their pipeline step.
const NA = 'North America'
const EU = 'Europe'
const APAC = 'Asia Pacific'

/** Dates are relative to server start so "overdue" and "last twelve months" stay meaningful whenever the demo runs. */
export function seed(): { customers: Customer[]; deals: Deal[]; cohorts: Cohort[] } {
  const customers: Customer[] = [
    { id: 'c1', name: 'Globex Corporation', email: 'hank@globex.example', status: 'active', dueDate: isoDay(-6), meta: { phone: '+1 555 0102', city: 'Springfield', source: 'Referral' } },
    { id: 'c2', name: 'Initech', email: 'bill@initech.example', status: 'active', dueDate: isoDay(12), meta: { phone: '+1 555 0147', city: 'Austin', source: 'Website' } },
    { id: 'c3', name: 'Umbrella Health', email: 'ops@umbrella.example', status: 'lead', dueDate: isoDay(-1), meta: { phone: '+44 20 7946 0958', city: 'London', source: 'Conference' } },
    { id: 'c4', name: 'Stark Logistics', email: 'pepper@stark.example', status: 'churned', dueDate: isoDay(30), meta: { city: 'New York', source: 'Cold email' } },
  ]
  const won = (id: string, customerId: string, title: string, amount: number, month: number, dayOfMonth: number, owner: string): Deal => ({
    id,
    customerId,
    title,
    amount,
    stage: 'won',
    meta: { closedOn: inMonth(month, dayOfMonth), owner, region: NA },
  })
  const open = (id: string, customerId: string, title: string, amount: number, stage: 'lead' | 'proposal', step: string, owner: string, region: string): Deal => ({
    id,
    customerId,
    title,
    amount,
    stage,
    meta: { step, owner, region },
  })
  const deals: Deal[] = [
    // the deals the demo started with (the film and the tests open Globex: its two deals stay as they were)
    { id: 'd1', customerId: 'c1', title: 'Annual licence', amount: 48000, stage: 'won', meta: { closedOn: inMonth(-3, 18), owner: 'Maya Chen', region: NA } },
    open('d2', 'c1', 'Support upgrade', 9500, 'proposal', 'Negotiation', 'Maya Chen', NA),
    open('d3', 'c2', 'Pilot', 12000, 'lead', 'Qualified', 'Leo Martins', NA),
    open('d4', 'c3', 'Clinic rollout', 76000, 'proposal', 'Proposal', 'Sofia Rossi', EU),
    { id: 'd5', customerId: 'c4', title: 'Fleet tracking', amount: 31000, stage: 'lost', meta: { closedOn: inMonth(-2, 9), owner: 'Leo Martins', region: NA } },
    // twelve months of won deals (revenue by month); Stark's stop when it churned
    won('w01', 'c4', 'Dispatch module', 38000, -12, 6, 'Leo Martins'),
    won('w02', 'c2', 'Seat expansion', 26000, -12, 19, 'Maya Chen'),
    won('w03', 'c2', 'Onboarding services', 18500, -11, 4, 'Maya Chen'),
    won('w04', 'c4', 'Driver app licences', 40000, -11, 22, 'Leo Martins'),
    won('w05', 'c2', 'Annual renewal', 52000, -10, 9, 'Maya Chen'),
    won('w06', 'c4', 'Route optimisation', 20000, -10, 27, 'Leo Martins'),
    won('w07', 'c4', 'Telematics add-on', 31500, -9, 12, 'Leo Martins'),
    won('w08', 'c2', 'Analytics module', 24000, -9, 16, 'Maya Chen'),
    won('w09', 'c2', 'Training package', 14000, -9, 26, 'Leo Martins'),
    won('w10', 'c2', 'API access tier', 45000, -8, 3, 'Maya Chen'),
    won('w11', 'c4', 'Fleet expansion', 36000, -8, 20, 'Leo Martins'),
    won('w12', 'c2', 'Data migration', 29000, -7, 8, 'Leo Martins'),
    won('w13', 'c2', 'Premium support', 48000, -7, 24, 'Maya Chen'),
    won('w14', 'c2', 'Austin office rollout', 62500, -6, 5, 'Leo Martins'),
    won('w15', 'c2', 'Usage overage', 28000, -6, 21, 'Maya Chen'),
    won('w16', 'c2', 'Reporting suite', 39000, -5, 11, 'Maya Chen'),
    won('w17', 'c2', 'Integration build', 47000, -5, 25, 'Leo Martins'),
    won('w18', 'c2', 'Seat expansion (East)', 58000, -4, 7, 'Maya Chen'),
    won('w19', 'c2', 'Security review', 46000, -4, 23, 'Leo Martins'),
    won('w20', 'c2', 'Multi-year renewal', 80400, -3, 10, 'Maya Chen'),
    won('w21', 'c2', 'Compliance pack', 41000, -2, 6, 'Leo Martins'),
    won('w22', 'c2', 'Seat expansion (West)', 56000, -2, 26, 'Maya Chen'),
    won('w23', 'c2', 'Workflow automation', 63500, -1, 9, 'Maya Chen'),
    won('w24', 'c2', 'Sandbox environments', 46000, -1, 21, 'Leo Martins'),
    { id: 'l1', customerId: 'c4', title: 'Annual renewal', amount: 44000, stage: 'lost', meta: { closedOn: inMonth(-5, 14), owner: 'Leo Martins', region: NA } },
    // the rest of the open pipeline
    open('o01', 'c2', 'Analytics add-on', 18500, 'lead', 'Qualified', 'Maya Chen', NA),
    open('o02', 'c3', 'Lab integrations', 22000, 'lead', 'Qualified', 'Jonas Weber', EU),
    open('o03', 'c3', 'Tokyo pilot', 19500, 'lead', 'Qualified', 'Kenji Watanabe', APAC),
    open('o04', 'c3', 'Singapore clinics', 54000, 'lead', 'Demo', 'Kenji Watanabe', APAC),
    open('o05', 'c2', 'Austin office seats', 14500, 'lead', 'Demo', 'Leo Martins', NA),
    open('o06', 'c4', 'Win-back: fleet pilot', 16000, 'lead', 'Demo', 'Maya Chen', NA),
    open('o07', 'c2', 'SSO and audit', 26000, 'proposal', 'Proposal', 'Leo Martins', NA),
    open('o08', 'c3', 'Sydney pharmacy chain', 41000, 'proposal', 'Proposal', 'Priya Nair', APAC),
    open('o09', 'c3', 'Berlin data residency', 38000, 'proposal', 'Negotiation', 'Jonas Weber', EU),
    open('o10', 'c2', 'Two-year renewal', 64000, 'proposal', 'Negotiation', 'Maya Chen', NA),
  ]
  // six signup cohorts: the oldest has six complete months after its signup month, the newest one
  const cohorts: Cohort[] = [
    { month: monthOf(-7), active: [42, 34, 30, 27, 25, 24, 23] },
    { month: monthOf(-6), active: [38, 32, 28, 26, 24, 23] },
    { month: monthOf(-5), active: [51, 44, 40, 36, 34] },
    { month: monthOf(-4), active: [47, 42, 38, 35] },
    { month: monthOf(-3), active: [56, 51, 47] },
    { month: monthOf(-2), active: [61, 57] },
  ]
  return { customers, deals, cohorts }
}
