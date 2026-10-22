import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createStoreApp, openStore } from '../../store-server/src/index.js'
import type { PleatkitManifest, Snapshot } from '@pleatkit/runtime/compiler'
import { checkSnapshotsCommand } from '../src/check-snapshots.js'
import { eraseCommand } from '../src/erase.js'
import { bugReport, redact } from '../src/report.js'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const DEMO = path.resolve(here, '../../../apps/demo-crm')
const DEMO_MANIFEST = path.join(DEMO, 'dist', 'pleatkit.manifest.json')

function store() {
  const { db } = openStore()
  const app = createStoreApp(db)
  const fetchVia = ((input: string | URL | Request, init?: RequestInit) => app.request(input instanceof Request ? input : String(input), init)) as typeof fetch
  const call = (method: string, p: string, headers: Record<string, string>, body?: unknown) =>
    app.request(`http://store.test/v1${p}`, { method, headers: { 'content-type': 'application/json', 'x-pleatkit-app': 'crm', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const put = async (s: Snapshot, head: boolean) => {
    expect((await call('PUT', `/snapshots/${s.id}`, { 'x-pleatkit-user': s.userId }, s)).status).toBe(204)
    if (head) expect((await call('POST', `/snapshots/${s.id}/head`, { 'x-pleatkit-user': s.userId }, {})).status).toBe(204)
  }
  return { fetchVia, call, put }
}

const snap = (id: string, userId: string, parentId: string | null, files: Record<string, string>, extra: Partial<Snapshot> = {}): Snapshot => ({
  id,
  userId,
  parentId,
  files,
  message: id,
  author: parentId ? 'agent' : 'base',
  createdAt: '',
  status: 'applied',
  ...extra,
})

describe('C13: pleatkit report', () => {
  const APP_KEY = 'mk_live_AbCdEfGhIjKlMnOpQrStUvWxYz012345'
  const JWT_SECRET = 'q'.repeat(48)

  it('redacts app keys, model keys, tokens, URL credentials, secret assignments and long opaque strings', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJlc2lnbmF0dXJl'
    const out = redact(`key ${APP_KEY}; sk-ant-api03-abcdefghij; ${jwt}; https://user:pass@store.example; jwtSecret: '${JWT_SECRET}'; apiKey = "short1"; ${'Z'.repeat(50)}`)
    for (const secret of [APP_KEY, 'api03-abcdefghij', jwt, 'user:pass', JWT_SECRET, 'short1', 'Z'.repeat(50)]) expect(out).not.toContain(secret)
    expect(out).toContain('mk_live_[redacted]')
    expect(redact('vite 7.1.7, react 19.2.0, /src/dynamic/**')).toBe('vite 7.1.7, react 19.2.0, /src/dynamic/**')
  })

  it('bundles doctor, versions, the redacted config and environment, and the manifest summary, without secrets', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pleatkit-report-'))
    fs.writeFileSync(
      path.join(root, 'vite.config.ts'),
      `import pleatkit from '@pleatkit/vite-plugin'\nconst appKey = '${APP_KEY}'\nexport default { plugins: [pleatkit({ zones: { dynamic: ['src/dynamic/**'] }, publicKey: '${'P'.repeat(43)}' })] }\n`,
    )
    fs.mkdirSync(path.join(root, 'dist'))
    fs.writeFileSync(path.join(root, 'dist', 'pleatkit.manifest.json'), JSON.stringify({ version: 1, dynamicRoots: ['src/dynamic/'], dynamic: [{ path: 'src/dynamic/a.tsx', source: 'SECRET PANEL CODE' }], readonly: [], externals: ['react'], css: { mode: 'tailwind' } }))
    const env = { PLEATKIT_APP_KEY: APP_KEY, PLEATKIT_JWT_SECRET: JWT_SECRET, PLEATKIT_STORE_URL: 'https://store.example', PLEATKIT_API_KEY: 'sk-ant-api03-zzzzzzzzzzzz', HOME: '/home/x' }
    const r = await bugReport({ root, env, findings: [{ id: 'config', status: 'fail', title: 'pleatkit plugin found', details: [`key ${APP_KEY}`], fix: 'x' }] })
    const md = r.markdown
    for (const secret of [APP_KEY, JWT_SECRET, 'zzzzzzzzzzzz', 'SECRET PANEL CODE']) expect(md).not.toContain(secret)
    expect(md).toContain('| node | ' + process.version + ' |')
    expect(md).toContain('| @pleatkit/runtime |')
    expect(md).toContain('[FAIL]')
    expect(md).toContain("const appKey = '[redacted]'")
    expect(md).toContain('- `PLEATKIT_APP_KEY`: set (value not shown)')
    expect(md).toContain('- `PLEATKIT_STORE_URL`: `https://store.example`')
    expect(md).not.toContain('HOME')
    expect(md).toContain('1 dynamic files, 0 readonly files, 1 externals')
  })
})

describe.skipIf(!fs.existsSync(DEMO_MANIFEST))('DECISIONS 67.5: pleatkit check-snapshots --typecheck on the demo app', () => {
  it('a version that compiles but reads a field the demo’s types do not have fails only with --typecheck', async () => {
    const t = store()
    const m = JSON.parse(fs.readFileSync(DEMO_MANIFEST, 'utf8')) as PleatkitManifest
    const base = Object.fromEntries(m.dynamic.map((f) => [f.path, f.source]))
    const card = 'src/dynamic/customer-card.tsx'
    // alice: the e2e scenario 1 edit (phone, city, source; overdue in red); bob: reads customer.score, which Customer lacks
    const scenario1 = fs.readFileSync(path.join(DEMO, 'e2e', 'fixtures', 'customer-card.scenario1.tsx'), 'utf8')
    const bobCard = base[card]!.replace('{customer.email}', '{customer.email} {customer.score}')
    expect(bobCard).not.toBe(base[card])
    for (const [u, files] of [
      ['alice', { ...base, [card]: scenario1 }],
      ['bob', { ...base, [card]: bobCard }],
    ] as const) {
      await t.put(snap(`01${u}0`, u, null, base), false)
      await t.put(snap(`01${u}1`, u, `01${u}0`, files), true)
    }
    const args = { store: 'http://store.test', app: 'crm', manifest: DEMO_MANIFEST, fetch: t.fetchVia }
    const plain = await checkSnapshotsCommand(args)
    expect(plain.ok).toBe(true)
    expect(plain.lines.filter((l) => l.startsWith('[ok]'))).toHaveLength(2)
    const typed = await checkSnapshotsCommand({ ...args, typecheck: true, root: DEMO })
    expect(typed.ok).toBe(false)
    expect(typed.lines.find((l) => l.includes('alice'))).toMatch(/^\[ok\]/)
    expect(typed.lines.find((l) => l.includes(' bob '))).toMatch(/^\[FAIL\]/)
    expect(typed.lines.join('\n')).toMatch(/score/)
  }, 60_000)
})

describe('DECISIONS 70.2: pleatkit erase', () => {
  const CARD = 'src/dynamic/card.tsx'
  it('prints what would go and a token; with --confirm erases the user; the app the same way', async () => {
    const t = store()
    await t.put(snap('01A', 'alice', null, { [CARD]: 'export default function Card() { return <div>v1</div> }\n' }), false)
    await t.put(snap('01B', 'alice', '01A', { [CARD]: 'export default function Card() { return <div>mine</div> }\n' }), true)
    await t.put(snap('01C', 'bob', null, { [CARD]: 'export default function Card() { return <div>v1</div> }\n' }), true)
    const base = { store: 'http://store.test', app: 'crm', fetch: t.fetchVia }
    const plan = await eraseCommand({ ...base, user: 'alice' })
    expect(plan).toMatchObject({ ok: true, erased: false })
    expect(plan.lines).toContain('  snapshots: 2')
    const token = /--confirm ([0-9a-f]+)/.exec(plan.lines.at(-1)!)![1]!
    const stale = await eraseCommand({ ...base, user: 'alice', confirm: 'f'.repeat(16) })
    expect(stale).toMatchObject({ ok: false, erased: false })
    const done = await eraseCommand({ ...base, user: 'alice', confirm: token })
    expect(done).toMatchObject({ ok: true, erased: true })
    expect(done.lines.at(-1)).toMatch(/^audit tombstone erased:[0-9a-f]{16} /)
    expect((await t.call('GET', '/heads/alice', { 'x-pleatkit-user': 'alice' })).status).toBe(200)
    expect(((await (await t.call('GET', '/heads/alice', { 'x-pleatkit-user': 'alice' })).json()) as { snapshot: unknown }).snapshot).toBeNull()

    const app = await eraseCommand(base)
    expect(app.lines[0]).toMatch(/^erasing app crm/)
    const appToken = /--confirm ([0-9a-f]+)/.exec(app.lines.at(-1)!)![1]!
    expect(await eraseCommand({ ...base, confirm: appToken })).toMatchObject({ ok: true, erased: true })
    expect(((await (await t.call('GET', '/heads/bob', { 'x-pleatkit-user': 'bob' })).json()) as { snapshot: unknown }).snapshot).toBeNull()
  })

  it('a non-admin is told what it needs', async () => {
    const { db } = openStore()
    const app = createStoreApp(db, { auth: { apps: { crm: { appKey: 'mk_live_0123456789abcdefghijklmnop', jwtSecret: 's'.repeat(40) } } } })
    const fetchVia = ((input: string | URL | Request, init?: RequestInit) => app.request(input instanceof Request ? input : String(input), init)) as typeof fetch
    const r = await eraseCommand({ store: 'http://store.test', app: 'crm', user: 'alice', fetch: fetchVia })
    expect(r.ok).toBe(false)
    expect(r.lines.join('\n')).toMatch(/PLEATKIT_APP_KEY/)
  })
})
