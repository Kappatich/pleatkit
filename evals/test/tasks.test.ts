import { describe, expect, it } from 'vitest'
import { loadFixtures } from '@pleatkit/agent'
import { PREDICATES } from '../src/predicates.js'
import { FIXTURE_DIRS, loadTasks, prepareTask, validateTask } from '../src/tasks.js'
import { CARD, changeTask, MANIFEST } from './helpers.js'

describe('evals/tasks: the demo-crm suite', () => {
  const tasks = loadTasks()
  const fixtures = new Set(FIXTURE_DIRS.flatMap((d) => loadFixtures(d)).map((f) => f.name))

  it('has at least 12 valid tasks; every change task has a reference; everything they name exists', () => {
    expect(tasks.length).toBeGreaterThanOrEqual(12)
    for (const t of tasks) {
      if (t.expected.change) expect(t.reference, t.id).toBeDefined()
      expect(fixtures.has(t.record!.fixture), `${t.id}: fixture ${t.record?.fixture}`).toBe(true)
      for (const p of t.invariants?.predicates ?? []) expect(PREDICATES[p], `${t.id}: predicate ${p}`).toBeDefined()
    }
  })

  it('covers the scenarios of the demo: every verdict and the request shapes', () => {
    const verdicts = new Set(tasks.map((t) => t.expected.verdict))
    for (const v of ['ok', 'partial', 'needs-backend', 'not-editable', 'declined', 'clarify', 'refused']) expect(verdicts.has(v as never), v).toBe(true)
    expect(tasks.some((t) => t.images?.length && t.target)).toBe(true)
    expect(tasks.some((t) => t.migration)).toBe(true)
    expect(tasks.some((t) => t.clarification)).toBe(true)
    expect(tasks.some((t) => t.locale === 'ru')).toBe(true)
  })
})

describe('task format', () => {
  it('validateTask names each problem', () => {
    const problems = validateTask({ id: 'Bad Id', app: 'other' as never, request: '', expected: { verdict: 'ok', change: true }, images: ['nope.png'], invariants: { forbidden: ['('] } }, 'x.json')
    expect(problems.join('\n')).toMatch(/x\.json: id must be/)
    expect(problems.join('\n')).toMatch(/app must be one of demo-crm, shadcn-admin, tailadmin, antd-dashboard, mesa/)
    expect(problems.join('\n')).toMatch(/request is required/)
    expect(problems.join('\n')).toMatch(/needs a reference solution/)
    expect(problems.join('\n')).toMatch(/images: nope\.png does not exist/)
    expect(problems.join('\n')).toMatch(/invalid regular expression \(/)
    expect(validateTask(changeTask())).toEqual([])
  })

  it('prepareTask builds the request the agent server would: trusted context from the manifest', () => {
    const p = prepareTask(changeTask({ target: 'customer-card', clarification: { question: 'Q?', answer: 'A' }, migration: { oldBaseSuffix: '\n// old\n', edited: {} } }), MANIFEST)
    expect(p.request.components).toEqual([CARD, 'src/dynamic/deals-table.tsx'])
    expect(p.request.context.namespace).toBe('eval-t-phone')
    expect(p.request.readonly['src/readonly/api.ts']).toContain('interface Customer')
    expect(p.request.target).toBe('customer-card')
    expect(p.request.migration!.oldBase[CARD]).toMatch(/\/\/ old\n$/)
    expect(p.request.files[CARD]).not.toMatch(/\/\/ old/)
    expect(p.trusted.base[CARD]).toBe(p.start[CARD])
  })
})

describe('browser checks by text (stage 5)', () => {
  it('a check needs a testid, a text or a panel; classMatches must be a valid expression', () => {
    const t = changeTask({ invariants: { browser: { checks: [{ within: 'customer-card', byText: 'active', classMatches: 'rounded' }, {} as never, { testid: 'x', classMatches: '(' }] } } })
    const problems = validateTask(t, 'y.json').join('\n')
    expect(problems).toMatch(/checks\[1\] needs testid, byText, within or panel/)
    expect(problems).toMatch(/invalid regular expression \(/)
    expect(problems).not.toMatch(/checks\[0\]/)
  })
})

describe('the demo documents the testid convention the field checks rely on (stage 5)', () => {
  it('vite.config passes docs/design-system.md as the designSystem docs, and it states the rule', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { DEMO_DIR } = await import('../src/tasks.js')
    expect(fs.readFileSync(path.join(DEMO_DIR, 'vite.config.ts'), 'utf8')).toMatch(/designSystem: \{ components: \['@\/components\/ui\/\*'\], docs: 'docs\/design-system\.md' \}/)
    const docs = fs.readFileSync(path.join(DEMO_DIR, 'docs', 'design-system.md'), 'utf8')
    expect(docs).toMatch(/Data fields keep `data-testid` equal to the field name/)
    // a testid checked inside a panel is a data field of the demo (the convention), never one a fixture made up
    const fields = new Set(['phone', 'city', 'source', 'due-date', 'email', 'status'])
    const used = loadTasks().flatMap((t) => (t.invariants?.browser?.checks ?? []).filter((c) => c.testid && c.within).map((c) => `${t.id}: ${c.testid}`))
    expect(used.filter((u) => !fields.has(u.split(': ')[1]!))).toEqual([])
  })
})
