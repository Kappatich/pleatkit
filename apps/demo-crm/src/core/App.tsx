import { useEffect, useState } from 'react'
import { DevPanel, Dynamic, PleatkitProvider, usePleatkit } from '@pleatkit/runtime'
import { detectLocale, PleatkitChat } from '@pleatkit/ui'
import { api, type Customer, type Deal } from '@/readonly/api'
import { formatDate } from '@/readonly/format'
import { cn } from '@/lib/utils'
import { Admin } from './Admin'
import { adminTranslator } from './admin-i18n'
import { AGENT_URL, APP_ID, AUTH, BUNDLE_URL, COMPILE, demoPublicKey, pleatkitConfig, storeFor, tokenFor, USERS, VIEWER, type UserId } from './pleatkit'

function readParams() {
  const params = new URLSearchParams(location.search)
  const user = params.get('user')
  return {
    user: (USERS as readonly string[]).includes(user ?? '') ? (user as UserId) : 'alice',
    dev: params.get('dev') === '1',
    isolated: params.get('isolated') === '1',
  }
}

/** Interface language of the chat and the admin dashboard: `?lang=ru`, English by default (DECISIONS item 20). */
const LOCALE = detectLocale('en')

const ADMIN_HREF = '/admin' + (() => {
  const q = new URLSearchParams()
  if (APP_ID !== 'demo-crm') q.set('app', APP_ID)
  if (LOCALE !== 'en') q.set('lang', LOCALE)
  return q.size ? `?${q}` : ''
})()

const EXAMPLES = {
  en: ['In the customer card add phone, city and source; highlight an overdue payment date in red', 'Add a discount field to deals and recalculate the amount on the server'],
  ru: ['В карточке клиента добавь телефон, город и источник; просроченную дату платежа выделяй красным', 'Добавь в сделку поле «скидка» и пересчитывай сумму на сервере'],
}

export function App() {
  if (location.pathname.replace(/\/$/, '') === '/admin') return <Admin appId={APP_ID} locale={LOCALE} />
  return <Crm />
}

function Crm() {
  const [{ user, dev, isolated }, setParams] = useState(readParams)
  // `?auth=token`: bundles must be signed by the app key; its public key comes from the demo's backend
  const [publicKey, setPublicKey] = useState<string | null | undefined>(AUTH === 'token' ? undefined : null)
  useEffect(() => {
    if (publicKey === undefined) void demoPublicKey().then(setPublicKey, () => setPublicKey(null))
  }, [publicKey])

  const switchUser = (next: UserId) => {
    const url = new URL(location.href)
    url.searchParams.set('user', next)
    history.replaceState(null, '', url)
    setParams((p) => ({ ...p, user: next }))
  }

  if (publicKey === undefined) return null
  return (
    <PleatkitProvider
      config={pleatkitConfig}
      store={storeFor(user)}
      userId={user}
      agentUrl={AGENT_URL}
      bundleUrl={BUNDLE_URL}
      locale={LOCALE}
      {...(COMPILE ? { compile: COMPILE } : {})}
      {...(publicKey ? { publicKey } : {})}
      {...(AUTH === 'token' ? { token: (o?: { refresh?: boolean }) => tokenFor(user, 'user', o?.refresh), onAuthExpired: () => tokenFor(user, 'user', true) } : {})}
    >
      <RefreshOnFocus />
      {EVAL_HOOK ? <EvalHook /> : null}
      {VIEWER ? <ViewingAs user={user} /> : null}
      {/* Leave room for the fixed dev panel so it does not cover the panels being edited. */}
      <div className="min-h-screen" style={dev ? { paddingRight: 580 } : undefined}>
        <header className="border-b border-border bg-card">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold">Acme CRM</span>
              <span className="text-xs text-muted-foreground">pleatkit demo</span>
            </div>
            <div className="flex items-center gap-4 text-sm">
              <a className="text-muted-foreground hover:underline" href={ADMIN_HREF}>
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
      {dev ? (
        <DevPanel />
      ) : VIEWER ? null : (
        <PleatkitChat agentUrl={AGENT_URL} appId={APP_ID} locale={LOCALE} examples={EXAMPLES[LOCALE]} {...(AUTH === 'token' ? { token: () => tokenFor(user) } : {})} />
      )}
    </PleatkitProvider>
  )
}

/**
 * C8: the support view (`?as=support`, from /admin's "View as"). The panels run the user's version from
 * store-server, read with `x-pleatkit-act-as` (every read audited); the data is the viewer's own, from the app's
 * backend. No chat: support looks and, if needed, restores a version from /admin, it does not edit as the user.
 */
function ViewingAs({ user }: { user: string }) {
  const tr = adminTranslator(LOCALE)
  const back = '/admin' + (APP_ID !== 'demo-crm' || LOCALE !== 'en' ? `?${[APP_ID !== 'demo-crm' ? `app=${encodeURIComponent(APP_ID)}` : '', LOCALE !== 'en' ? `lang=${LOCALE}` : ''].filter(Boolean).join('&')}` : '')
  return (
    <div data-testid="viewing-as" data-user={user} style={{ background: '#111', color: '#fff', font: '13px/1.4 "Helvetica Neue", Helvetica, Arial, sans-serif', borderBottom: '3px solid #e30613' }}>
      <div style={{ maxWidth: 1152, margin: '0 auto', padding: '9px 24px', display: 'flex', gap: 16, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 14 }}>{tr('adm.va.banner', { user })}</b>
        <span style={{ color: '#bdbdbd', flex: '1 1 320px' }}>{tr('adm.va.note')}</span>
        <a href={back} style={{ color: '#fff', textDecoration: 'underline', textUnderlineOffset: 3 }}>
          {tr('adm.va.exit')}
        </a>
      </div>
    </div>
  )
}

/**
 * `?eval=1`: the eval harness's browser grader (evals/browser) commits an agent result through this engine, the
 * same `draft.commit('agent')` the chat runs after an answer, then checks the rendered panels.
 */
const EVAL_HOOK = new URLSearchParams(location.search).get('eval') === '1'

function EvalHook() {
  const engine = usePleatkit()
  useEffect(() => {
    const w = window as unknown as { __pleatkitEval?: unknown }
    w.__pleatkitEval = engine
    return () => {
      delete w.__pleatkitEval
    }
  }, [engine])
  return null
}

/** Pick up changes made elsewhere (an admin rolled this user back) when the tab regains focus. */
function RefreshOnFocus() {
  const engine = usePleatkit()
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
