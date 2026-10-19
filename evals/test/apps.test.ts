import { describe, expect, it } from 'vitest'
import { oracleProvider } from '../src/providers.js'
import { APPS, routeOf } from '../src/apps.js'
import { gradeInvariants, type RunResult } from '../src/graders.js'
import { hueOf, PREDICATES } from '../src/predicates.js'
import { renderReport } from '../src/report.js'
import { runSuite } from '../src/runner.js'
import { loadSuites, prepareTask, validateTask } from '../src/tasks.js'
import { CARD, changeTask, MANIFEST, noChangeTask, PHONE_CARD } from './helpers.js'

const result = (over: Partial<RunResult> = {}): RunResult => ({
  verdict: 'ok',
  summary: 'Done.',
  files: { [CARD]: PHONE_CARD },
  deleted: [],
  log: [],
  classification: 'ui',
  provider: 'test',
  model: 'test',
  usage: [],
  modelCalls: 1,
  timings: { totalMs: 1, classifyMs: null, modelMs: 0, toolsMs: 0 },
  ...over,
})

describe('stage 5 block 2: the foreign apps (DECISIONS 73.1)', () => {
  it('the apps suite: 35 valid tasks over shadcn-admin and TailAdmin, 3 adversarial, a reference for every change', () => {
    const tasks = loadSuites(['apps'])
    expect(tasks).toHaveLength(35)
    expect(new Set(tasks.map((t) => t.app))).toEqual(new Set(['shadcn-admin', 'tailadmin']))
    expect(tasks.filter((t) => t.expected.verdict === 'declined')).toHaveLength(3)
    expect(tasks.every((t) => !t.expected.change || t.reference)).toBe(true)
    // every browser check of a foreign app names one of its panels, never a test id
    for (const t of tasks) for (const c of t.invariants?.browser?.checks ?? []) expect(c.testid, t.id).toBeUndefined()
  })

  it('validates the app and the panels a check names', () => {
    expect(validateTask({ ...changeTask(), app: 'nope' as never }, 'x.json').join('\n')).toMatch(/app must be one of demo-crm, shadcn-admin, tailadmin, antd-dashboard, mesa/)
    const bad = { ...changeTask({ reference: undefined, expected: { verdict: 'needs-backend', change: false } }), app: 'tailadmin' as const, invariants: { browser: { checks: [{ panel: 'users-table' }] } } }
    expect(validateTask(bad, 'y.json').join('\n')).toMatch(/users-table is not a panel of tailadmin/)
    expect(validateTask({ ...bad, invariants: { browser: { checks: [{ panel: 'basic-table', matches: '(' }] } } }, 'z.json').join('\n')).toMatch(/invalid regular expression/)
  })

  it('a task runs on the route of its panel', () => {
    expect(routeOf('shadcn-admin', 'users-table')).toBe('/users')
    expect(routeOf('tailadmin', 'basic-table')).toBe('/basic-tables')
    expect(routeOf('tailadmin')).toBe(APPS.tailadmin.defaultPath)
  })

  it('anyMustMatch: some file of the result matches, whichever the agent chose', () => {
    const p = prepareTask(changeTask({ invariants: { anyMustMatch: ['meta\\.phone'] } }), MANIFEST)
    expect(gradeInvariants(p, result())).toMatchObject({ pass: true })
    expect(gradeInvariants(p, result({ files: {} }))).toMatchObject({ pass: false, reason: 'no dynamic file matches /meta\\.phone/' })
  })

  it('chart-colors-green reads the first colour of a chart option', () => {
    expect(hueOf('#12b76a')).toBeGreaterThan(140)
    expect(hueOf('#465fff')).toBeGreaterThan(220)
    expect(hueOf('rgb(16, 185, 129)')).toBeGreaterThan(140)
    expect(hueOf('green')).toBe(120)
    expect(hueOf('#888')).toBeNull()
    const check = (src: string) => PREDICATES['chart-colors-green']!.check({ task: changeTask(), result: result(), final: {}, changed: { 'src/dynamic/chart.tsx': src } })
    expect(check('const o = { colors: ["#12b76a"] }')).toBeNull()
    expect(check('const o = { colors: ["#465fff"] }')).toMatch(/not green/)
    expect(check('const o = {}')).toBe('no chart colours were changed')
  })

  it('runSuite takes one manifest per app, and the report has a row per app', async () => {
    const tasks = [changeTask(), { ...changeTask({ id: 't-foreign' }), app: 'shadcn-admin' as const, invariants: {} }, { ...noChangeTask({ id: 't-foreign-backend' }), app: 'tailadmin' as const }]
    const s = await runSuite({ kind: 'replay', agent: 'reference', tasks, manifests: { 'demo-crm': MANIFEST, 'shadcn-admin': MANIFEST, tailadmin: MANIFEST }, providerFor: (t) => oracleProvider(t, { write: true }) })
    expect(s.runs.map((r) => [r.taskId, r.app ?? 'demo-crm', r.pass])).toEqual([
      ['t-phone', 'demo-crm', true],
      ['t-foreign', 'shadcn-admin', true],
      ['t-foreign-backend', 'tailadmin', true],
    ])
    expect(Object.keys(s.prompt.byApp ?? {})).toEqual(['demo-crm', 'shadcn-admin', 'tailadmin'])
    const html = renderReport(s, null)
    expect(html).toContain('<h2>By app</h2>')
    expect(html).toMatch(/<b>tailadmin<\/b><\/td><td class="n">1 \/ 1/)
    await expect(runSuite({ kind: 'replay', agent: 'reference', tasks: [tasks[1]!], manifests: {}, providerFor: (t) => oracleProvider(t, { write: true }) })).rejects.toThrow(/no build manifest for shadcn-admin/)
  })
})
