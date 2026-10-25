// Typed client for the demo data server. Readonly zone: the agent reads it, cannot edit it.

export type Meta = Record<string, unknown>

export interface Customer {
  id: string
  name: string
  email: string
  status: 'lead' | 'active' | 'churned'
  /** ISO date (yyyy-mm-dd) of the next payment or follow-up */
  dueDate: string
  /** Free-form fields (phone, city, source, ...). Safe to read and display; may be missing. */
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: { 'content-type': 'application/json' }, ...init })
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} /api${path} failed: ${res.status}`)
  return (await res.json()) as T
}

export const api = {
  customers: () => request<Customer[]>('/customers'),
  customer: (id: string) => request<Customer>(`/customers/${id}`),
  deals: (customerId?: string) => request<Deal[]>(customerId ? `/deals?customerId=${encodeURIComponent(customerId)}` : '/deals'),
  /** Signup cohorts of the last months, oldest first (retention). */
  cohorts: () => request<Cohort[]>('/cohorts'),
  updateCustomerMeta: (id: string, meta: Meta) => request<Customer>(`/customers/${id}/meta`, { method: 'PATCH', body: JSON.stringify(meta) }),
  updateDealMeta: (id: string, meta: Meta) => request<Deal>(`/deals/${id}/meta`, { method: 'PATCH', body: JSON.stringify(meta) }),
}
