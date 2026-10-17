import { useEffect, useState } from 'react'
import { DevPanel, Dynamic, MorphkitProvider } from '@morphkit/runtime'
import { api, type Customer, type Deal } from '@/readonly/api'
import { formatDate } from '@/readonly/format'
import { cn } from '@/lib/utils'
import { morphkitConfig, store, USERS, type UserId } from './morphkit'

function readParams() {
  const params = new URLSearchParams(location.search)
  const user = params.get('user')
  return {
    user: (USERS as readonly string[]).includes(user ?? '') ? (user as UserId) : 'alice',
    dev: params.get('dev') === '1',
  }
}

export function App() {
  const [{ user, dev }, setParams] = useState(readParams)

  const switchUser = (next: UserId) => {
    const url = new URL(location.href)
    url.searchParams.set('user', next)
    history.replaceState(null, '', url)
    setParams((p) => ({ ...p, user: next }))
  }

  return (
    <MorphkitProvider config={morphkitConfig} store={store} userId={user}>
      {/* Leave room for the fixed dev panel so it does not cover the panels being edited. */}
      <div className="min-h-screen" style={dev ? { paddingRight: 580 } : undefined}>
        <header className="border-b border-border bg-card">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold">Acme CRM</span>
              <span className="text-xs text-muted-foreground">morphkit demo</span>
            </div>
            <label className="flex items-center gap-2 text-sm">
              Signed in as
              <select
                data-testid="user-switch"
                value={user}
                onChange={(e) => switchUser(e.target.value as UserId)}
                className="rounded-md border border-border bg-background px-2 py-1"
              >
                {USERS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </header>
        <CrmPage />
      </div>
      {dev && <DevPanel />}
    </MorphkitProvider>
  )
}

function CrmPage() {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [deals, setDeals] = useState<Deal[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([api.customers(), api.deals()])
      .then(([c, d]) => {
        setCustomers(c)
        setDeals(d)
        setSelectedId((id) => id ?? c[0]?.id ?? null)
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  const selected = customers.find((c) => c.id === selectedId) ?? null
  if (error) return <p className="p-6 text-red-700">Could not load data: {error}. Is the data server running?</p>

  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-6 py-6">
      <Dynamic id="dashboard-panels" props={{ customers, deals }} />
      <div className="grid gap-6 md:grid-cols-[260px_1fr]">
        <nav aria-label="Customers" className="rounded-xl border border-border bg-card p-2">
          <ul data-testid="customer-list">
            {customers.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  className={cn('w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted', c.id === selectedId && 'bg-muted font-medium')}
                >
                  {c.name}
                  <span className="block text-xs text-muted-foreground">due {formatDate(c.dueDate)}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="grid content-start gap-6">
          {selected && <Dynamic id="customer-card" props={{ customer: selected }} />}
          {selected && <Dynamic id="deals-table" props={{ deals: deals.filter((d) => d.customerId === selected.id) }} />}
        </div>
      </div>
    </main>
  )
}
