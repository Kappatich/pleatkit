import { useEffect, useState } from 'react'
import { DevPanel, Dynamic, MorphkitProvider, useMorphkit } from '@morphkit/runtime'
import { MorphkitChat } from '@morphkit/ui'
import { api, type Customer, type Deal } from '@/readonly/api'
import { formatDate } from '@/readonly/format'
import { cn } from '@/lib/utils'
import { Admin } from './Admin'
import { AGENT_URL, APP_ID, morphkitConfig, storeFor, USERS, type UserId } from './morphkit'

function readParams() {
  const params = new URLSearchParams(location.search)
  const user = params.get('user')
  return {
    user: (USERS as readonly string[]).includes(user ?? '') ? (user as UserId) : 'alice',
    dev: params.get('dev') === '1',
    isolated: params.get('isolated') === '1',
  }
}

const EXAMPLES = [
  'In the customer card add phone, city and source; highlight an overdue payment date in red',
  'Add a discount field to deals and recalculate the amount on the server',
]

export function App() {
  if (location.pathname.replace(/\/$/, '') === '/admin') return <Admin appId={APP_ID} />
  return <Crm />
}

function Crm() {
  const [{ user, dev, isolated }, setParams] = useState(readParams)

  const switchUser = (next: UserId) => {
    const url = new URL(location.href)
    url.searchParams.set('user', next)
    history.replaceState(null, '', url)
    setParams((p) => ({ ...p, user: next }))
  }

  return (
    <MorphkitProvider config={morphkitConfig} store={storeFor(user)} userId={user}>
      <RefreshOnFocus />
      {/* Leave room for the fixed dev panel so it does not cover the panels being edited. */}
      <div className="min-h-screen" style={dev ? { paddingRight: 580 } : undefined}>
        <header className="border-b border-border bg-card">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold">Acme CRM</span>
              <span className="text-xs text-muted-foreground">morphkit demo</span>
            </div>
            <div className="flex items-center gap-4 text-sm">
              <a className="text-muted-foreground hover:underline" href={`/admin${APP_ID !== 'demo-crm' ? `?app=${encodeURIComponent(APP_ID)}` : ''}`}>
                Admin
              </a>
              <label className="flex items-center gap-2">
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
          </div>
        </header>
        <CrmPage isolated={isolated} />
      </div>
      {dev ? <DevPanel /> : <MorphkitChat agentUrl={AGENT_URL} appId={APP_ID} examples={EXAMPLES} />}
    </MorphkitProvider>
  )
}

/** Pick up changes made elsewhere (an admin rolled this user back) when the tab regains focus. */
function RefreshOnFocus() {
  const engine = useMorphkit()
  useEffect(() => {
    const onFocus = () => void engine.refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [engine])
  return null
}

function CrmPage({ isolated }: { isolated: boolean }) {
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
      {/* With ?isolated=1 this panel runs in a sandboxed iframe (opaque origin, no access to the page). */}
      <Dynamic id="dashboard-panels" props={{ customers, deals }} isolated={isolated} />
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
