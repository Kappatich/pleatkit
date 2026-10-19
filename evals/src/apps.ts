import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const EVALS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(EVALS, '..')

/** The apps eval tasks run against: the demo CRM, two foreign admin templates (DECISIONS 73.1) and the two blind installs of block 5. */
export const APP_IDS = ['demo-crm', 'shadcn-admin', 'tailadmin', 'antd-dashboard', 'mesa'] as const
export type AppId = (typeof APP_IDS)[number]

export interface EvalApp {
  id: AppId
  /** The app's folder (its build, its node_modules for the tsc grader). */
  dir: string
  /** Where its routes live: `demo` has a data server and a customer list; `static` is a Vite build with in-code data. */
  kind: 'demo' | 'static'
  /** Route the browser grader opens when a task names none. */
  defaultPath: string
  /**
   * Panels that must render on each route after any edit: the demo by `data-testid`, a foreign app by its
   * `<Dynamic id>` (the runtime's `data-pleatkit-id` wrapper must have a visible child).
   */
  panels: Record<string, string[]>
  /** Where the task's tasks live (`evals/tasks` for the demo, `evals/tasks/apps` for the foreign apps). */
  suite: 'demo' | 'apps'
  /** How it is built for the evals (shown in the error when its build is missing). */
  build: string
}

export const APPS: Record<AppId, EvalApp> = {
  'demo-crm': {
    id: 'demo-crm',
    dir: path.join(REPO, 'apps', 'demo-crm'),
    kind: 'demo',
    defaultPath: '/',
    panels: { '/': ['customer-card', 'deals-table', 'dashboard-panels'] },
    suite: 'demo',
    build: 'pnpm build',
  },
  'shadcn-admin': {
    id: 'shadcn-admin',
    dir: path.join(EVALS, 'apps', 'shadcn-admin'),
    kind: 'static',
    defaultPath: '/',
    panels: { '/': ['dashboard-stats', 'revenue-chart', 'recent-sales'], '/users': ['users-table'], '/tasks': ['tasks-table'] },
    suite: 'apps',
    build: 'cd evals/apps/shadcn-admin && pnpm install --ignore-workspace && pnpm build',
  },
  tailadmin: {
    id: 'tailadmin',
    dir: path.join(EVALS, 'apps', 'tailadmin'),
    kind: 'static',
    defaultPath: '/',
    panels: { '/': ['ecommerce-metrics', 'monthly-sales-chart', 'recent-orders'], '/basic-tables': ['basic-table'] },
    suite: 'apps',
    build: 'cd evals/apps/tailadmin && npm ci && npm run build',
  },
  // stage 5 block 5: the two apps installed blind by a fresh agent from docs/for-agents (brainstorm 17 §2)
  'antd-dashboard': {
    id: 'antd-dashboard',
    dir: path.join(EVALS, 'apps', 'antd-dashboard'),
    kind: 'static',
    defaultPath: '/dashboards/default',
    panels: { '/dashboards/default': ['stat-cards', 'tasks-list'], '/dashboards/ecommerce': ['orders-status-chart', 'recent-orders'] },
    suite: 'apps',
    build: 'cd evals/apps/antd-dashboard && pnpm install --ignore-workspace --ignore-scripts && pnpm build',
  },
  mesa: {
    id: 'mesa',
    dir: path.join(EVALS, 'apps', 'mesa'),
    kind: 'static',
    defaultPath: '/',
    panels: { '/': ['overview-stats'], '/channels': ['channel-comparison'], '/menu': ['menu-items-table'] },
    suite: 'apps',
    build: 'cd evals/apps/mesa && npm ci && npm run build',
  },
}

export const isAppId = (x: unknown): x is AppId => typeof x === 'string' && (APP_IDS as readonly string[]).includes(x)
export const manifestFile = (app: AppId): string => path.join(APPS[app].dir, 'dist', 'pleatkit.manifest.json')
/** The app's packages for the tsc grader: its own node_modules (DECISIONS 63.4), when installed. */
export const typecheckRootOf = (app: AppId): string | null => (fs.existsSync(path.join(APPS[app].dir, 'node_modules', 'react')) ? APPS[app].dir : null)
/** The route a task's panel lives on (its first route listing the panel), else the app's default. */
export function routeOf(app: AppId, panel?: string): string {
  if (panel) for (const [route, ids] of Object.entries(APPS[app].panels)) if (ids.includes(panel)) return route
  return APPS[app].defaultPath
}
