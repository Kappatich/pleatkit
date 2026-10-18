import { describe, expect, it } from 'vitest'
import { createTypechecker } from '@pleatkit/agent'
import { finalFiles, gradeChange, gradeCheck, gradeInvariants, gradePredicates, gradeTypecheck, gradeVerdict, type RunResult } from '../src/graders.js'
import { PREDICATES, visibleStrings } from '../src/predicates.js'
import { prepareTask } from '../src/tasks.js'
import { BASE_CARD, CARD, changeTask, MANIFEST, noChangeTask, PHONE_CARD, TABLE } from './helpers.js'

const result = (over: Partial<RunResult> = {}): RunResult => ({
  verdict: 'ok',
  summary: 'The card now shows the phone.',
  files: { [CARD]: PHONE_CARD },
  deleted: [],
  log: [],
  classification: 'ui',
  provider: 'test',
  model: 'test',
  usage: [],
  modelCalls: 2,
  timings: { totalMs: 1, classifyMs: null, modelMs: 0, toolsMs: 0 },
  ...over,
})

describe('graders: each returns pass/fail and a reason', () => {
  const p = prepareTask(changeTask(), MANIFEST)

  it('verdict: exact match, with the stop reason when it differs', () => {
    expect(gradeVerdict(p.task, result())).toMatchObject({ grader: 'verdict', pass: true })
    const bad = gradeVerdict(p.task, result({ verdict: 'failed', stopReason: 'calls' }))
    expect(bad).toMatchObject({ pass: false })
    expect(bad.reason).toMatch(/expected ok, got failed \(stopped: calls\)/)
  })

  it('change: a change task needs files, a no-change task must leave them alone', () => {
    expect(gradeChange(p.task, result()).pass).toBe(true)
    expect(gradeChange(p.task, result({ files: {} })).reason).toMatch(/nothing was changed/)
    const q = prepareTask(noChangeTask(), MANIFEST)
    expect(gradeChange(q.task, result({ files: {} })).pass).toBe(true)
    expect(gradeChange(q.task, result()).reason).toMatch(/nothing should change, 1 file/)
  })

  it('check: the shared compile and static rules, on the base files with the change applied', async () => {
    expect(await gradeCheck(p, result())).toMatchObject({ pass: true })
    const broken = await gradeCheck(p, result({ files: { [CARD]: 'export default function C() { return <div><span></div> }' } }))
    expect(broken.pass).toBe(false)
    const rule = await gradeCheck(p, result({ files: { [CARD]: PHONE_CARD.replace("'—'", "localStorage.getItem('x') ?? '—'") } }))
    expect(rule.pass).toBe(false)
    expect(rule.reason).toMatch(/localStorage/)
    expect(await gradeCheck(p, result({ files: {} }))).toMatchObject({ pass: true, skipped: true })
  })

  it('typecheck: skipped without a root, refuses a wrong field with one', async () => {
    expect(await gradeTypecheck(p, result(), null)).toMatchObject({ pass: true, skipped: true })
    const tc = createTypechecker()
    expect(await gradeTypecheck(p, result(), tc)).toMatchObject({ pass: true })
    const bad = await gradeTypecheck(p, result({ files: { [CARD]: PHONE_CARD.replace('customer.name', 'customer.nmae') } }), tc)
    expect(bad.pass).toBe(false)
    expect(bad.reason).toMatch(/nmae/)
  })

  it('invariants: kept testids, forbidden patterns, untouched files', () => {
    expect(gradeInvariants(p, result())).toMatchObject({ pass: true })
    const lost = gradeInvariants(p, result({ files: { [CARD]: BASE_CARD } }))
    expect(lost.reason).toMatch(/lost "data-testid=\\"phone\\""/)
    const forbidden = gradeInvariants(p, result({ files: { [CARD]: PHONE_CARD + '\n// localStorage\n', [TABLE]: 'x' } }))
    expect(forbidden.reason).toMatch(/forbidden pattern \/localStorage\//)
    expect(forbidden.reason).toMatch(/deals-table.tsx was changed/)
    expect(gradeInvariants(prepareTask(noChangeTask(), MANIFEST), result())).toMatchObject({ pass: true, skipped: true })
  })

  it('predicates: named custom checks, an unknown name fails loudly', () => {
    expect(gradePredicates(p, result())).toMatchObject({ pass: true })
    expect(gradePredicates(p, result({ summary: 'Updated src/dynamic/customer-card.tsx' })).reason).toMatch(/plain-summary/)
    const unknown = prepareTask(changeTask({ invariants: { predicates: ['no-such-check'] } }), MANIFEST)
    expect(gradePredicates(unknown, result()).reason).toMatch(/unknown predicate "no-such-check"/)
  })

  it('custom predicates read the result: labels, clarify, model calls, attachments', () => {
    const ctx = (r: Partial<RunResult>, files = {}) => ({ task: changeTask({ images: ['a.png'] }), result: result(r), final: {}, changed: files })
    expect(PREDICATES['labels-in-panel-language']!.check(ctx({}, { [CARD]: 'const l = "Средняя сделка"' }))).toMatch(/not in the panel's language/)
    expect(PREDICATES['labels-in-panel-language']!.check(ctx({}, { [CARD]: '// комментарий\nconst l = "Average deal"' }))).toBeNull()
    expect(PREDICATES['clarify-question']!.check(ctx({ clarify: { question: 'Which?', options: ['a'] } }))).toMatch(/1 options/)
    expect(PREDICATES['no-main-model-calls']!.check(ctx({ modelCalls: 1 }))).toMatch(/1 model call/)
    expect(PREDICATES['images-received']!.check(ctx({ attachments: { images: 0, imageBytes: 0, targetDomChars: 0 } }))).toMatch(/got 0 image/)
    expect(PREDICATES['summary-in-russian']!.check(ctx({ summary: 'Готово.' }))).toBeNull()
    expect(visibleStrings('<b>Hi</b> {x ? "a" : `b`}')).toEqual(['a', 'b', 'Hi'])
  })

  it('finalFiles applies changes and deletions to the start files', () => {
    expect(finalFiles({ a: '1', b: '2' }, { files: { b: '3', c: '4' }, deleted: ['a'] })).toEqual({ b: '3', c: '4' })
  })
})
