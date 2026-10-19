import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatPlan, parsePanels, suggest, writePlan } from '../src/suggest.js'

const dirs: string[] = []
function app(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pleatkit-suggest-'))
  dirs.push(root)
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  return root
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const tsconfigAt = JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] })
// a comment inside, as real tsconfig files have
const tsconfigApp = `{
  // alias
  "compilerOptions": { "paths": { "@/*": ["./src/*"] } },
  "include": ["src"]
}`

/** shadcn-like: flat UI kit, Tailwind 4, TanStack Router, a table with its columns, row actions that use a provider. */
function shadcnLike(): string {
  return app({
    'package.json': JSON.stringify({ dependencies: { react: '^19.0.0', '@tanstack/react-table': '^8', '@tanstack/react-router': '^1', 'lucide-react': '^0.5' }, devDependencies: { tailwindcss: '^4.1.0', '@tailwindcss/vite': '^4.1.0' } }),
    'tsconfig.json': tsconfigAt,
    'tsconfig.app.json': tsconfigApp,
    'vite.config.ts': `import path from 'path'\nexport default defineConfig({ resolve: { alias: { '@': path.resolve(__dirname, './src') } } })`,
    'src/main.tsx': `import './styles/index.css'\n`,
    'src/styles/index.css': `@import 'tailwindcss';\n`,
    'src/components/ui/table.tsx': `export function Table() { return <table /> }\nexport function TableRow() { return <tr /> }`,
    'src/components/ui/badge.tsx': `export function Badge() { return <span /> }`,
    'src/components/ui/button.tsx': `export function Button() { return <button /> }`,
    'src/lib/utils.ts': `export const cn = (...a: string[]) => a.join(' ')`,
    'src/routes/users.tsx': `import { createFileRoute } from '@tanstack/react-router'\nimport { Users } from '@/features/users'\nexport const Route = createFileRoute('/users')({ component: Users })`,
    'src/features/users/index.tsx': [
      `import { UsersTable } from './components/users-table'`,
      `import { UsersProvider } from './components/users-provider'`,
      `import { users } from './data/users'`,
      `export function Users() {`,
      `  return <UsersProvider><UsersTable data={users} /></UsersProvider>`,
      `}`,
    ].join('\n'),
    'src/features/users/data/users.ts': `export const users = [{ id: 1, name: 'a' }]`,
    'src/features/users/data/schema.ts': `export interface User { id: number; name: string }\nexport type Role = 'admin' | 'user'`,
    'src/features/users/data/data.ts': `export const roles = ['admin', 'user']\nexport const callTypes = new Map()\nexport const unused = 1`,
    'src/features/users/components/users-provider.tsx': `export function UsersProvider({ children }: { children: React.ReactNode }) { return children }\nexport const useUsers = () => ({})`,
    'src/features/users/components/row-actions.tsx': `import { useUsers } from './users-provider'\nimport { Button } from '@/components/ui/button'\nexport function RowActions() { useUsers(); return <Button /> }`,
    'src/features/users/components/users-columns.tsx': [
      `import { type ColumnDef } from '@tanstack/react-table'`,
      `import { Badge } from '@/components/ui/badge'`,
      `import { callTypes } from '../data/data'`,
      `import { type User } from '../data/schema'`,
      `import { RowActions } from './row-actions'`,
      `export const columns: ColumnDef<User>[] = [{ id: 'a', cell: () => <><Badge />{callTypes.size}<RowActions /></> }]`,
    ].join('\n'),
    'src/features/users/components/users-table.tsx': [
      `import { useReactTable } from '@tanstack/react-table'`,
      `import { getRouteApi } from '@tanstack/react-router'`,
      `import { cn } from '@/lib/utils'`,
      `import { Table, TableRow } from '@/components/ui/table'`,
      `import { roles } from '../data/data'`,
      `import type { User } from '../data/schema'`,
      `import { columns } from './users-columns'`,
      `const route = getRouteApi('/users')`,
      `export function UsersTable({ data }: { data: User[] }) {`,
      `  const search = route.useSearch()`,
      `  const navigate = route.useNavigate()`,
      `  useReactTable({ data, columns })`,
      `  return <Table className={cn('a')}>{data.map((u) => <TableRow key={u.id} />)}{roles.length}{String(search)}{String(navigate)}</Table>`,
      `}`,
    ].join('\n'),
  })
}

/** TailAdmin-like: a UI kit with a folder per component (one with an index), no Tailwind, React Router, ApexCharts. */
function tailadminLike(): string {
  return app({
    'package.json': JSON.stringify({ dependencies: { react: '^19.0.0', 'react-apexcharts': '^2', apexcharts: '^5', 'react-router': '^7' } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
    'vite.config.ts': `export default defineConfig({ resolve: { alias: { '@': '/src' } } })`,
    'src/App.tsx': [
      `import { Routes, Route } from 'react-router'`,
      `import Dashboard from './pages/Dashboard'`,
      `import Orders from './pages/Orders'`,
      `export default function App() { return <Routes><Route path="/" element={<Dashboard />} /><Route path="/orders/:id" element={<Orders />} /></Routes> }`,
    ].join('\n'),
    'src/components/ui/badge/Badge.tsx': `export default function Badge({ children }: { children: React.ReactNode }) { return <span>{children}</span> }`,
    'src/components/ui/table/index.tsx': `export function Table() { return <table /> }\nexport function TableCell() { return <td /> }`,
    'src/components/common/PageMeta.tsx': `export default function PageMeta() { return null }`,
    'src/pages/Dashboard.tsx': [
      `import PageMeta from '../components/common/PageMeta'`,
      `import RecentOrders from '../components/ecommerce/RecentOrders'`,
      `import SalesChart from '@/components/ecommerce/SalesChart'`,
      `export default function Dashboard() { return <><PageMeta /><SalesChart /><RecentOrders /></> }`,
    ].join('\n'),
    'src/pages/Orders.tsx': [`import OrderCard from '../components/orders/OrderCard'`, `export default function Orders() { return <OrderCard /> }`].join('\n'),
    'src/components/ecommerce/SalesChart.tsx': [
      `import Chart from 'react-apexcharts'`,
      `import type { ApexOptions } from 'apexcharts'`,
      `const options: ApexOptions = {`,
      `  chart: { type: 'bar', height: 180 },`,
      `  colors: ['#465fff'],`,
      `  xaxis: { categories: ['Jan', 'Feb', 'Mar'] },`,
      `  legend: { show: false },`,
      `  dataLabels: { enabled: false },`,
      `  grid: { yaxis: { lines: { show: true } } },`,
      `  fill: { opacity: 1 },`,
      `  stroke: { show: true, width: 4 },`,
      `}`,
      `export default function SalesChart() { return <div><Chart options={options} series={[{ data: [1, 2, 3] }]} /></div> }`,
    ].join('\n'),
    'src/components/ecommerce/RecentOrders.module.css': `.row { color: red }`,
    'src/components/ecommerce/RecentOrders.tsx': [
      `import Badge from '../ui/badge/Badge'`,
      `import { Table, TableCell } from '@/components/ui/table'`,
      `import styles from './RecentOrders.module.css'`,
      `const tableData = [`,
      `  { id: 1, name: 'MacBook', status: 'Delivered' },`,
      `  { id: 2, name: 'Watch', status: 'Pending' },`,
      `]`,
      `export default function RecentOrders() {`,
      `  return <div className={styles.row}><h3>Orders</h3><Table>{tableData.map((o) => <TableCell key={o.id}><Badge>{o.status}</Badge>{o.name}</TableCell>)}</Table></div>`,
      `}`,
    ].join('\n'),
    'src/components/orders/OrderCard.tsx': [
      `import { useNavigate, useParams } from 'react-router'`,
      `import Badge from '../ui/badge/Badge'`,
      `export default function OrderCard() {`,
      `  const { id } = useParams()`,
      `  const navigate = useNavigate()`,
      `  return <div onClick={() => navigate('/')}><Badge>{id}</Badge></div>`,
      `}`,
    ].join('\n'),
  })
}

describe('pleatkit init --suggest', () => {
  it('flat UI kit: helpers move, state stays in core, re-exports carry exactly the symbols used, router hooks become props', () => {
    const plan = suggest({ root: shadcnLike(), panels: [{ file: 'src/features/users/components/users-table.tsx' }] })
    const [p] = plan.panels
    expect(p!.id).toBe('users-table')
    expect(p!.component).toBe('UsersTable')
    expect(p!.target).toBe('src/dynamic/users-table.tsx')
    expect(p!.helpers).toEqual([{ file: 'src/features/users/components/users-columns.tsx', target: 'src/dynamic/users-columns.tsx', action: 'move' }])
    expect(p!.keptInCore.map((k) => k.file)).toEqual(['src/features/users/components/row-actions.tsx'])
    expect(p!.hookProps.map((h) => h.prop)).toEqual(['search', 'navigate'])
    expect(p!.renderSites).toHaveLength(1)
    const site = p!.renderSites[0]!
    expect(site.file).toBe('src/features/users/index.tsx')
    expect(site.props).toEqual(['data', 'search', 'navigate'])
    expect(site.add).toEqual([`import { getRouteApi } from '@tanstack/react-router'`, `const route = getRouteApi('/users')`, 'const search = route.useSearch()', 'const navigate = route.useNavigate()'])
    expect(site.replacement).toBe('<Dynamic id="users-table" props={{ data: users, search, navigate }} />')
    expect(plan.readonlyModules.map((r) => r.path)).toEqual(['src/readonly/users.ts'])
    expect(plan.readonlyModules[0]!.source).toBe(
      [
        '// What the users-table panel needs from the app (readonly zone, imported as @/readonly/users).',
        `export { RowActions } from '@/features/users/components/row-actions'`,
        `export { callTypes, roles } from '@/features/users/data/data'`,
        `export type { User } from '@/features/users/data/schema'`,
        '',
      ].join('\n'),
    )
    expect(p!.imports.find((i) => i.file === p!.file && i.to === '@/readonly/users')!.line).toBe(`import { roles, type User } from '@/readonly/users'`)
    // getRouteApi went to the page: the router is not an external; the kit is one flat entry
    expect(plan.externals).toEqual(['react', 'react-dom', 'react/jsx-runtime', '@/readonly/*', '@/components/ui/*', '@/lib/utils', '@tanstack/react-table', 'lucide-react'])
    expect(plan.readonlyFiles).toEqual(['src/components/ui/badge.tsx', 'src/components/ui/table.tsx', 'src/lib/utils.ts'])
    expect(plan.readonlyZone).toEqual(['src/readonly/**', 'src/components/ui/{badge,table}.tsx', 'src/lib/utils.ts'])
    expect(plan.css).toEqual({ mode: 'tailwind', tailwindEntry: 'src/styles/index.css' })
    expect(plan.kit).toEqual({ dir: 'src/components/ui', layout: 'flat', clean: true })
    expect(plan.alias.todo).toEqual([])
    expect(plan.core.types).toContain('src/features/users/data/schema.ts')
    expect(plan.manifest).toEqual({
      panels: ['users-table'],
      dynamic: ['src/dynamic/users-columns.tsx', 'src/dynamic/users-table.tsx'],
      readonly: ['src/components/ui/badge.tsx', 'src/components/ui/table.tsx', 'src/lib/utils.ts', 'src/readonly/users.ts'],
    })
    expect(plan.plugin).toContain(`css: 'tailwind', tailwindEntry: 'src/styles/index.css',`)
    expect(plan.plugin).toContain(`designSystem: { components: ['@/components/ui/*'] },`)
    expect(formatPlan(plan)).toContain('router hook → prop "search": route.useSearch()')
  })

  it('folder-per-component kit: one external per module, a folder with an index by its folder; CSS module helpers move; type-only packages are not externals', () => {
    const root = tailadminLike()
    const plan = suggest({ root, panels: parsePanels('src/components/ecommerce/RecentOrders.tsx,src/components/ecommerce/SalesChart.tsx:monthly-sales-chart') })
    expect(plan.panels.map((p) => p.id)).toEqual(['recent-orders', 'monthly-sales-chart'])
    expect(plan.panels[0]!.helpers).toEqual([{ file: 'src/components/ecommerce/RecentOrders.module.css', target: 'src/dynamic/RecentOrders.module.css', action: 'move' }])
    expect(plan.panels[0]!.imports.map((i) => i.line)).toEqual([`import Badge from '@/components/ui/badge/Badge'`])
    expect(plan.panels[1]!.renderSites[0]!.replacement).toBe('<Dynamic id="monthly-sales-chart" />')
    expect(plan.externals).toEqual(['react', 'react-dom', 'react/jsx-runtime', '@/components/ui/badge/Badge', '@/components/ui/table', 'react-apexcharts'])
    expect(plan.readonlyZone).toEqual(['src/components/ui/badge/Badge.tsx', 'src/components/ui/table/index.tsx'])
    expect(plan.readonlyModules).toEqual([])
    expect(plan.kit).toEqual({ dir: 'src/components/ui', layout: 'folders', clean: true })
    expect(plan.css).toEqual({ mode: 'palette' })
    expect(plan.plugin).toContain(`css: 'palette',`)
    expect(plan.plugin).not.toContain('tailwindEntry')
  })

  it('React Router hooks of a page component become props; the page gets the hook calls', () => {
    const plan = suggest({ root: tailadminLike(), panels: [{ file: 'src/components/orders/OrderCard.tsx' }] })
    const [p] = plan.panels
    expect(p!.hookProps.map((h) => [h.prop, h.hook])).toEqual([
      ['id', 'useParams()'],
      ['navigate', 'useNavigate()'],
    ])
    expect(p!.renderSites[0]!.file).toBe('src/pages/Orders.tsx')
    expect(p!.renderSites[0]!.add).toEqual([`import { useParams } from 'react-router'`, 'const id = useParams()', `import { useNavigate } from 'react-router'`, 'const navigate = useNavigate()'])
    expect(p!.props).toEqual(['id', 'navigate'])
    expect(plan.externals).not.toContain('react-router')
  })

  it('without --panels the heuristic ranks what the pages render: tables and charts, not layout', () => {
    const plan = suggest({ root: tailadminLike() })
    expect(plan.mode).toBe('heuristic')
    expect(plan.panels.map((p) => p.file)).toEqual(['src/components/ecommerce/RecentOrders.tsx', 'src/components/ecommerce/SalesChart.tsx'])
    expect(plan.candidates.map((c) => c.file)).not.toContain('src/components/common/PageMeta.tsx')
    expect(plan.candidates.find((c) => c.file.endsWith('SalesChart.tsx'))!.reasons[0]).toBe('chart (react-apexcharts)')
  })

  it('resolves the app\'s own alias and says the @ alias is missing', () => {
    const root = app({
      'package.json': '{}',
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '~/*': ['./src/*'] } } }),
      'vite.config.ts': `import { fileURLToPath } from 'node:url'\nexport default { resolve: { alias: [{ find: '~', replacement: fileURLToPath(new URL('./src', import.meta.url)) }] } }`,
      'src/App.tsx': `import { createBrowserRouter } from 'react-router-dom'\nimport Home from '~/pages/Home'\nexport const router = createBrowserRouter([{ path: '/', element: <Home /> }])`,
      'src/pages/Home.tsx': `import { Stats } from '~/widgets/Stats'\nexport default function Home() { return <Stats /> }`,
      'src/lib/format.ts': `export const money = (n: number) => '$' + n`,
      'src/widgets/Stats.tsx': `import { money } from '~/lib/format'\nexport function Stats() { return <div>{money(1)}</div> }`,
    })
    const plan = suggest({ root, panels: [{ file: 'src/widgets/Stats.tsx' }] })
    expect(plan.alias.vite).toEqual({ '~': 'src' })
    expect(plan.alias.tsconfig).toEqual({ '~': 'src' })
    expect(plan.alias.todo).toHaveLength(2)
    expect(plan.panels[0]!.renderSites[0]!.file).toBe('src/pages/Home.tsx')
    expect(plan.readonlyFiles).toEqual(['src/lib/format.ts'])
    expect(plan.externals).toContain('@/lib/format')
    expect(plan.panels[0]!.imports.map((i) => i.line)).toEqual([`import { money } from '@/lib/format'`])
  })

  it('--panels parsing: ids and components', () => {
    expect(parsePanels('a.tsx, src/b.tsx:my-id,c.tsx#Card:card-x')).toEqual([{ file: 'a.tsx' }, { file: 'src/b.tsx', id: 'my-id' }, { file: 'c.tsx', id: 'card-x', component: 'Card' }])
  })

  it('--write creates only the readonly re-export modules, never overwrites, and lists what it did not do', () => {
    const root = shadcnLike()
    const plan = suggest({ root, panels: [{ file: 'src/features/users/components/users-table.tsx' }] })
    const w = writePlan(plan)
    expect(w.created).toEqual(['src/readonly/users.ts'])
    expect(fs.readFileSync(path.join(root, 'src/readonly/users.ts'), 'utf8')).toBe(plan.readonlyModules[0]!.source)
    expect(fs.existsSync(path.join(root, 'src/dynamic'))).toBe(false)
    expect(w.notDone.some((n) => n.includes('users-table') && n.includes('<Dynamic id="users-table">'))).toBe(true)
    fs.writeFileSync(path.join(root, 'src/readonly/users.ts'), '// mine\n')
    expect(writePlan(plan).skipped).toEqual(['src/readonly/users.ts (exists; not overwritten)'])
    expect(fs.readFileSync(path.join(root, 'src/readonly/users.ts'), 'utf8')).toBe('// mine\n')
  })

  it('--write leaves out of "not done" what is already in place (blind install 4)', () => {
    const root = shadcnLike()
    const plan = suggest({ root, panels: [{ file: 'src/features/users/components/users-table.tsx' }] })
    expect(writePlan(plan).notDone.some((n) => n.includes('plugin block'))).toBe(true)
    fs.writeFileSync(path.join(root, 'vite.config.ts'), `import pleatkit from '@pleatkit/vite-plugin'\nexport default { plugins: [pleatkit({})] }\n`)
    fs.writeFileSync(path.join(root, 'tsconfig.app.json'), `{ "compilerOptions": { "types": ["vite/client", "@pleatkit/vite-plugin/client"] } }\n`)
    fs.mkdirSync(path.join(root, 'src/dynamic'), { recursive: true })
    fs.writeFileSync(path.join(root, plan.panels[0]!.target), 'export default function X() { return null }\n')
    const again = writePlan(plan).notDone
    expect(again.some((n) => n.includes('plugin block') || n.includes('types to the tsconfig') || n.includes('<Dynamic id="users-table">'))).toBe(false)
  })

  // install.md as amended after the third blind install
  const antdLike = (extra: Record<string, string> = {}) =>
    app({
      'package.json': JSON.stringify({ dependencies: { react: '^18.2.0', antd: '^6', 'react-router-dom': '^6' } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
      'vite.config.ts': `import path from 'path'\nexport default { resolve: { alias: { '@': path.resolve(__dirname, './src') } } }`,
      'src/App.tsx': `import { createBrowserRouter } from 'react-router-dom'\nimport Home from './pages/home'\nimport Other from './pages/other'\nexport const router = createBrowserRouter([{ path: '/', element: <Home /> }, { path: '/other', element: <Other /> }])`,
      'src/pages/home.tsx': `import { OrdersCard } from '../components'\nexport default function Home() { return <OrdersCard title="Orders" /> }`,
      'src/pages/other.tsx': `import { AdvancedTable } from '../components/shared/advanced-table'\nimport { money } from '../utils'\nimport type { Order } from '../types/order'\nconst rows: Order[] = []\nexport default function Other() { return <AdvancedTable rows={rows} label={money(1)} /> }`,
      'src/components/index.ts': `export * from './orders-card/orders-card'\nexport * from './shared/advanced-table'`,
      'src/components/orders-card/orders-card.tsx': [
        `import { Card, Table } from 'antd'`,
        `import { ColumnsType } from 'antd/es/table'`,
        `import { AdvancedTable } from '../shared/advanced-table'`,
        `import { money } from '../../utils'`,
        `import type { Order } from '../../types/order'`,
        `import { onlyHere } from '../../lib/only-here'`,
        `import './styles.css'`,
        `import css from './orders-card.module.css'`,
        `const columns: ColumnsType<Order> = []`,
        `export const OrdersCard = ({ title }: { title: string }) => <Card className={css.card} title={title}><Table columns={columns} /><AdvancedTable rows={[]} label={money(onlyHere)} /></Card>`,
      ].join('\n'),
      'src/components/orders-card/orders-card.stories.tsx': `import { OrdersCard } from './orders-card'\nexport const Default = () => <OrdersCard title="x" />`,
      'src/components/orders-card/styles.css': `.x { color: red }`,
      'src/components/orders-card/orders-card.module.css': `.card { padding: 1rem }`,
      'src/components/shared/advanced-table.tsx': `import type { Order } from '../../types/order'\nexport const AdvancedTable = (p: { rows: Order[]; label: string }) => <div>{p.label}{p.rows.length}</div>`,
      'src/utils/index.ts': `export const money = (n: number) => '$' + n\nexport const percent = (n: number) => n + '%'`,
      'src/types/order.ts': `export interface Order { id: number }\nexport type Status = 'open' | 'done'`,
      'src/lib/only-here.ts': `export const onlyHere = 1`,
      ...extra,
    })

  it('a panel file that a story or a barrel imports too is copied, not moved; the original stays', () => {
    const plan = suggest({ root: antdLike(), panels: [{ file: 'src/components/orders-card/orders-card.tsx' }] })
    const [p] = plan.panels
    expect(p!.action).toBe('copy')
    expect(p!.otherUsers).toEqual(['src/components/index.ts', 'src/components/orders-card/orders-card.stories.tsx'])
    expect(p!.alsoImportedBy).toEqual([])
    expect(p!.renderSites.map((s) => s.file)).toEqual(['src/pages/home.tsx'])
    const text = formatPlan(plan)
    expect(text).toContain('orders-card: copy src/components/orders-card/orders-card.tsx (OrdersCard) → src/dynamic/orders-card.tsx, as the default export (it has other users: src/components/index.ts, src/components/orders-card/orders-card.stories.tsx; the original stays)')
    expect(text).not.toContain('update their paths')
    // a panel only its page renders is still moved
    const moved = suggest({ root: tailadminLike(), panels: [{ file: 'src/components/ecommerce/RecentOrders.tsx' }] })
    expect(moved.panels[0]!.action).toBe('move')
  })

  it('a global stylesheet of a copied component stays; CSS modules go with the copy; a moved component takes its stylesheet', () => {
    const plan = suggest({ root: antdLike(), panels: [{ file: 'src/components/orders-card/orders-card.tsx' }] })
    const [p] = plan.panels
    expect(p!.stays).toEqual([{ file: 'src/components/orders-card/styles.css', reason: 'global stylesheet, still imported by the original' }])
    expect(p!.helpers).toEqual([{ file: 'src/components/orders-card/orders-card.module.css', target: 'src/dynamic/orders-card.module.css', action: 'copy' }])
    expect(p!.imports.some((i) => i.line.startsWith(`(remove) import './styles.css'`))).toBe(true)
    expect(formatPlan(plan)).toContain('stays: src/components/orders-card/styles.css (global stylesheet, still imported by the original)')
    // without the story and the barrel the component moves, and its stylesheet with it
    const root = antdLike({
      'src/pages/home.tsx': `import { OrdersCard } from '../components/orders-card/orders-card'\nexport default function Home() { return <OrdersCard title="Orders" /> }`,
      'src/components/index.ts': `export * from './shared/advanced-table'`,
    })
    fs.rmSync(path.join(root, 'src/components/orders-card/orders-card.stories.tsx'))
    const movedPlan = suggest({ root, panels: [{ file: 'src/components/orders-card/orders-card.tsx' }] })
    expect(movedPlan.panels[0]!.action).toBe('move')
    expect(movedPlan.panels[0]!.stays).toEqual([])
    expect(movedPlan.panels[0]!.helpers.map((h) => [h.file, h.action])).toEqual([
      ['src/components/orders-card/orders-card.module.css', 'move'],
      ['src/components/orders-card/styles.css', 'move'],
    ])
  })

  it('modules the rest of the app uses too get small re-export modules with the exact names; whole files only when only the panels use them', () => {
    const plan = suggest({ root: antdLike(), panels: [{ file: 'src/components/orders-card/orders-card.tsx' }] })
    expect(plan.readonlyModules.map((r) => r.source)).toEqual([
      `// What the orders-card panel needs from the app (readonly zone, imported as @/readonly/components).\nexport { AdvancedTable } from '@/components/shared/advanced-table'\n`,
      `// What the orders-card panel needs from the app (readonly zone, imported as @/readonly/types).\nexport type { Order } from '@/types/order'\n`,
      `// What the orders-card panel needs from the app (readonly zone, imported as @/readonly/utils).\nexport { money } from '@/utils'\n`,
    ])
    expect(plan.readonlyFiles).toEqual(['src/lib/only-here.ts'])
    expect(plan.readonlyZone).toEqual(['src/readonly/**', 'src/lib/only-here.ts'])
    expect(plan.panels[0]!.imports.map((i) => i.line)).toContain(`import { money } from '@/readonly/utils'`)
  })

  it('a name reached through a barrel is re-exported from the module that declares it, once for every panel', () => {
    const root = antdLike({
      'src/pages/home.tsx': `import { OrdersCard } from '../components'\nimport { SalesCard } from '../components/sales-card/sales-card'\nexport default function Home() { return <><OrdersCard title="Orders" /><SalesCard /></> }`,
      'src/components/sales-card/sales-card.tsx': `import { AdvancedTable } from '..'\nexport function SalesCard() { return <AdvancedTable rows={[]} label="sales" /> }`,
    })
    const plan = suggest({ root, panels: parsePanels('src/components/orders-card/orders-card.tsx,src/components/sales-card/sales-card.tsx') })
    const components = plan.readonlyModules.find((r) => r.path === 'src/readonly/components.ts')!
    expect(components.source.split('\n').slice(1)).toEqual([`export { AdvancedTable } from '@/components/shared/advanced-table'`, ''])
    expect(components.usedBy).toEqual(['orders-card', 'sales-card'])
    expect(plan.panels[1]!.imports.map((i) => i.line)).toEqual([`import { AdvancedTable } from '@/readonly/components'`])
  })

  it('a package import used only as a type needs no external', () => {
    const plan = suggest({ root: antdLike(), panels: [{ file: 'src/components/orders-card/orders-card.tsx' }] })
    expect(plan.externals).toEqual(['react', 'react-dom', 'react/jsx-runtime', '@/readonly/*', '@/lib/only-here', 'antd'])
    expect(plan.externals).not.toContain('antd/es/table')
  })

  it('a UI kit folder with stylesheets or tests is reached through src/readonly/ui.ts; a clean kit keeps its trailing *', () => {
    const root = app({
      'package.json': '{}',
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
      'vite.config.ts': `export default { resolve: { tsconfigPaths: true } }`,
      'src/App.tsx': `import { Routes, Route } from 'react-router'\nimport OverviewPage from './pages/OverviewPage'\nexport const App = () => <Routes><Route path="/" element={<OverviewPage />} /></Routes>`,
      'src/pages/OverviewPage.tsx': `import { Stats } from '@/features/stats/Stats'\nexport default function OverviewPage() { return <Stats /> }`,
      'src/features/stats/Stats.tsx': `import { StatTile } from '@/components/ui/StatTile'\nimport { Badge, type BadgeTone } from '@/components/ui/Badge'\nconst tone: BadgeTone = 'ok'\nexport function Stats() { return <div><StatTile label="Orders" value={3} /><Badge tone={tone} /></div> }`,
      'src/components/ui/StatTile.tsx': `import styles from './StatTile.module.css'\nexport function StatTile(p: { label: string; value: number }) { return <div className={styles.tile}>{p.label}{p.value}</div> }`,
      'src/components/ui/StatTile.module.css': `.tile { padding: 1rem }`,
      'src/components/ui/StatTile.test.tsx': `import { StatTile } from './StatTile'\nvoid StatTile`,
      'src/components/ui/Badge.tsx': `export type BadgeTone = 'ok' | 'bad'\nexport function Badge(p: { tone: BadgeTone }) { return <span>{p.tone}</span> }`,
    })
    const plan = suggest({ root, panels: [{ file: 'src/features/stats/Stats.tsx' }] })
    expect(plan.kit).toEqual({ dir: 'src/components/ui', layout: 'flat', clean: false })
    expect(plan.readonlyModules.map((r) => [r.path, r.source.split('\n').slice(1).join('\n')])).toEqual([
      ['src/readonly/ui.ts', `export { Badge } from '@/components/ui/Badge'\nexport type { BadgeTone } from '@/components/ui/Badge'\nexport { StatTile } from '@/components/ui/StatTile'\n`],
    ])
    expect(plan.externals).toEqual(['react', 'react-dom', 'react/jsx-runtime', '@/readonly/*'])
    expect(plan.readonlyZone).toEqual(['src/readonly/**'])
    expect(plan.designSystem).toEqual({ components: ['@/components/ui/*'] })
    // shadcn's kit (only .tsx files) keeps the trailing *
    const clean = suggest({ root: shadcnLike(), panels: [{ file: 'src/features/users/components/users-table.tsx' }] })
    expect(clean.externals).toContain('@/components/ui/*')
  })

  it('refuses a file outside src and two panels with one id', () => {
    const root = tailadminLike()
    expect(() => suggest({ root, panels: [{ file: 'vite.config.ts' }] })).toThrow(/not a source file/)
    expect(() => suggest({ root, panels: parsePanels('src/components/ecommerce/RecentOrders.tsx:x,src/components/ecommerce/SalesChart.tsx:x') })).toThrow(/two panels would get the id "x"/)
  })
})
