import { describe, expect, it } from 'vitest'
import { codeDiff, createJudge } from '../src/judge.js'
import { hasSuite, loadTasks, SUITES } from '../src/tasks.js'

describe('stage 5 block 5: the judge sees what a screenshot cannot (DECISIONS 82.3)', () => {
  it('codeDiff lists removed and added lines per changed file, marks new files, skips unchanged ones and caps the size', () => {
    const before = { 'a.tsx': 'line 1\nkeep\nold label\n', 'b.tsx': 'same\n' }
    const after = { 'a.tsx': 'line 1\nkeep\nnew label\n<a href={`mailto:${u.email}`}>{u.email}</a>\n', 'b.tsx': 'same\n', 'c.tsx': 'export default 1\n' }
    const d = codeDiff(before, after)
    expect(d).toContain('a.tsx\n- old label\n+ new label\n+ <a href={`mailto:${u.email}`}>{u.email}</a>')
    expect(d).toContain('c.tsx (new file)\n+ export default 1')
    expect(d).not.toContain('b.tsx')
    expect(codeDiff({}, { 'x.tsx': 'y'.repeat(5000) }, 100).length).toBeLessThanOrEqual(102)
  })

  it('the judge prompt carries the part passed to the server and the diff', async () => {
    let body = ''
    const fetchFn = (async (_url: unknown, init?: { body?: unknown }) => {
      body = String(init?.body ?? '')
      return new Response(
        JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: JSON.stringify({ design_system: 5, no_breakage: 5, did_what_asked: 5, nothing_unrelated: 5, overall: 5, reason: 'ok' }) }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const judge = createJudge({ apiKey: 'k', baseURL: 'http://anthropic.test', fetch: fetchFn })
    const j = await judge({ request: 'sort the sales, and e-mail a summary every morning', before: Buffer.from('a'), after: Buffer.from('b'), backendQuote: 'e-mail a summary every morning', diff: 'x.tsx\n+ rows.sort(byAmount)' })
    expect(j.score).toBe(5)
    expect(body).toContain('<passed_to_server>')
    expect(body).toContain('e-mail a summary every morning')
    expect(body).toContain('<code_diff>')
    expect(body).toContain('rows.sort(byAmount)')
  })
})

describe('stage 5 block 5: restore in the awkward suite (DECISIONS 82.2)', () => {
  it.skipIf(!hasSuite('awkward'))('"put the card back like it was before" also accepts the restore answer', () => {
    const t = loadTasks(SUITES.awkward).find((x) => x.id === 'aw-03-like-before')!
    expect(t.expected.alsoAccept).toContainEqual({ verdict: 'restore', change: false })
  })
})

describe('stage 5 block 5: cost against zone size (brainstorm 17 §3)', () => {
  it('zoneOf keeps the reference files first, then the same route, then the rest', async () => {
    const { zoneOf } = await import('../src/tasks.js')
    const files = ['src/dynamic/dashboard-stats.tsx', 'src/dynamic/recent-sales.tsx', 'src/dynamic/revenue-chart.tsx', 'src/dynamic/tasks-columns.tsx', 'src/dynamic/tasks-table.tsx', 'src/dynamic/users-columns.tsx', 'src/dynamic/users-table.tsx']
    const task = { app: 'shadcn-admin' as const, reference: { files: { 'src/dynamic/recent-sales.tsx': 'x' } } }
    expect([...zoneOf(task, files, 1)]).toEqual(['src/dynamic/recent-sales.tsx'])
    expect([...zoneOf(task, files, 3)].sort()).toEqual(['src/dynamic/dashboard-stats.tsx', 'src/dynamic/recent-sales.tsx', 'src/dynamic/revenue-chart.tsx'])
    expect(zoneOf(task, files, 7).size).toBe(7)
  })
})

describe('stage 5 block 5: a no-change answer the task also accepts skips the per-file invariants', () => {
  it('restore on "put it back like it was" leaves the files; their must-not-contain does not apply', async () => {
    const { gradeInvariants } = await import('../src/graders.js')
    const task = { id: 't', app: 'demo-crm', expected: { verdict: 'ok', change: true, alsoAccept: [{ verdict: 'restore', change: false }] }, invariants: { files: [{ path: 'a.tsx', mustNotContain: ['phone'] }], forbidden: ['evil'] } }
    const p = { task, start: { 'a.tsx': 'phone' } } as never
    const restore = gradeInvariants(p, { verdict: 'restore', files: {}, deleted: [] } as never)
    expect(restore.pass).toBe(true)
    const ok = gradeInvariants(p, { verdict: 'ok', files: {}, deleted: [] } as never)
    expect(ok.pass).toBe(false)
  })
})
