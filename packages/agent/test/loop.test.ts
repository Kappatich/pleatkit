import { describe, expect, it } from 'vitest'
import { runAgent } from '../src/loop.js'
import { Workspace, ZoneError } from '../src/workspace.js'
import { BASE_CARD, BROKEN_CARD, CARD, GOOD_CARD, request, scripted, TABLE } from './helpers.js'

describe('Workspace', () => {
  it('compiles the base files with the same virtual-fs and externals as the browser', async () => {
    const ws = new Workspace(request('x'))
    const r = await ws.check()
    expect(r).toMatchObject({ ok: true, errors: [] })
  })

  it('refuses writes outside the dynamic zone', () => {
    const ws = new Workspace(request('x'))
    expect(() => ws.write('src/readonly/api.ts', '')).toThrow(ZoneError)
    expect(() => ws.write('src/dynamic/../lib/utils.ts', '')).toThrow(ZoneError)
    expect(() => ws.write('src/dynamic/run.sh', '')).toThrow(ZoneError)
    ws.write('src/dynamic/new.tsx', 'export default () => null')
    expect(Object.keys(ws.changedFiles())).toEqual(['src/dynamic/new.tsx'])
  })

  it('reports syntax errors with file, line and 1-based column', async () => {
    const ws = new Workspace(request('x'))
    ws.write(CARD, BROKEN_CARD)
    const r = await ws.check()
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toMatchObject({ file: CARD, line: 2 })
    expect(r.errors[0]!.column).toBeGreaterThan(0)
  })

  it('reports panels that lost their default export, and unknown packages', async () => {
    const ws = new Workspace(request('x'))
    ws.write(CARD, `export function CustomerCard() { return null }`)
    expect((await ws.check()).errors.map((e) => e.text)).toEqual([expect.stringContaining(`no default export in ${CARD}`)])
    ws.write(CARD, `import _ from 'lodash'\nexport default () => _`)
    expect((await ws.check()).errors[0]!.text).toContain('Package "lodash" is not available')
  })
})

describe('runAgent with the scripted provider', () => {
  it('scenario 1: writes, checks and finishes ok; only changed files are returned', async () => {
    const provider = scripted({
      name: 'phone',
      turns: [
        { calls: [{ tool: 'read_file', input: { path: CARD }, expect: 'ok' }] },
        { calls: [{ tool: 'write_file', input: { path: CARD, content: GOOD_CARD }, expect: 'ok' }, { tool: 'check', input: {}, expect: 'ok' }] },
        { calls: [{ tool: 'finish', input: { verdict: 'ok', summary: 'Added the phone.' }, expect: 'ok' }] },
      ],
    })
    const events: string[] = []
    const r = await runAgent(request('show the phone'), provider, { onProgress: (p) => events.push(p.text) })
    expect(r.verdict).toBe('ok')
    expect(r.summary).toBe('Added the phone.')
    expect(Object.keys(r.files)).toEqual([CARD])
    expect(r.classification).toBe('ui')
    expect(r.modelCalls).toBe(3)
    expect(r.log.map((l) => l.tool)).toEqual(['read_file', 'write_file', 'check', 'finish'])
    expect(r.log[1]!.input).toEqual({ path: CARD, bytes: GOOD_CARD.length })
    expect(events).toEqual(
      expect.arrayContaining(['Understanding the request', 'Looking at the customer card', 'Changing the customer card', 'Checking that everything still works', 'Everything works']),
    )
    // the end user never sees code, file names or compiler output (DECISIONS item 10)
    for (const e of events) expect(e).not.toMatch(/\.tsx?\b|src\/|import |=>|<\w/)
  })

  it('scenario 2: the classifier sends backend work straight to the admin without the main model', async () => {
    const provider = scripted({ name: 'discount', classify: { label: 'needs-backend', reason: 'Recalculating the amount on the server needs a backend change.' }, turns: [] })
    const r = await runAgent(request('add a discount and recalc on the server'), provider)
    expect(r.verdict).toBe('needs-backend')
    expect(r.summary).toContain('server')
    expect(r.modelCalls).toBe(0)
    expect(r.files).toEqual({})
  })

  it('progress lines stay plain language even while fixing compile errors', async () => {
    const provider = scripted({
      name: 'broken',
      turns: [
        { text: 'const x = <div>', calls: [{ tool: 'write_file', input: { path: CARD, content: BROKEN_CARD } }, { tool: 'check', input: {} }] },
        { calls: [{ tool: 'finish', input: { verdict: 'failed', summary: 'x' } }] },
      ],
    })
    const events: { type: string; text: string }[] = []
    await runAgent(request('broken'), provider, { onProgress: (p) => events.push(p) })
    expect(events.map((e) => e.text)).toContain('Found a problem, fixing it')
    expect(JSON.stringify(events)).not.toContain('customer-card.tsx')
    expect(JSON.stringify(events)).not.toContain('<div>')
  })

  it('scenario 3: a commit that does not compile is rejected, the agent gets the error and fixes it', async () => {
    const provider = scripted({
      name: 'broken',
      turns: [
        { calls: [{ tool: 'write_file', input: { path: CARD, content: BROKEN_CARD } }, { tool: 'finish', input: { verdict: 'ok', summary: 'Done' }, expect: 'error' }] },
        { calls: [{ tool: 'write_file', input: { path: CARD, content: GOOD_CARD } }, { tool: 'check', input: {}, expect: 'ok' }] },
        { calls: [{ tool: 'finish', input: { verdict: 'ok', summary: 'Fixed and done.' }, expect: 'ok' }] },
      ],
    })
    const r = await runAgent(request('broken please'), provider)
    expect(r.verdict).toBe('ok')
    expect(r.files[CARD]).toBe(GOOD_CARD)
    const rejected = r.log.find((l) => l.tool === 'finish' && !l.ok)
    expect(rejected?.result).toContain('Commit rejected')
    expect(rejected?.result).toContain(`${CARD}:2:`)
  })

  it('logs zone violations and returns the error to the model', async () => {
    const provider = scripted({
      name: 'evil',
      turns: [
        { calls: [{ tool: 'write_file', input: { path: 'src/readonly/api.ts', content: 'x' }, expect: 'error' }] },
        { calls: [{ tool: 'finish', input: { verdict: 'failed', summary: 'Cannot.' } }] },
      ],
    })
    const r = await runAgent(request('evil'), provider)
    expect(r.verdict).toBe('failed')
    expect(r.log[0]).toMatchObject({ tool: 'write_file', ok: false })
    expect(r.log[0]!.violation).toContain('readonly')
  })

  it('needs-backend from the main model discards any written code', async () => {
    const provider = scripted({
      name: 'mixed',
      turns: [{ calls: [{ tool: 'write_file', input: { path: CARD, content: GOOD_CARD } }, { tool: 'finish', input: { verdict: 'needs-backend', summary: 'Server.' } }] }],
    })
    const r = await runAgent(request('mixed'), provider)
    expect(r).toMatchObject({ verdict: 'needs-backend', files: {} })
  })

  it('stops at the model-call limit', async () => {
    const provider = scripted({ name: 'loop', turns: Array.from({ length: 20 }, () => ({ calls: [{ tool: 'list_files', input: {} }] })) })
    const r = await runAgent(request('loop'), provider, { limits: { maxModelCalls: 4 } })
    expect(r).toMatchObject({ verdict: 'failed', stopReason: 'calls', modelCalls: 4 })
  })

  it('stops at the timeout', async () => {
    const provider = scripted({ name: 'slow', turns: [{ delayMs: 2_000, calls: [{ tool: 'list_files', input: {} }] }] })
    const r = await runAgent(request('slow'), provider, { limits: { timeoutMs: 100 } })
    expect(r).toMatchObject({ verdict: 'failed', stopReason: 'timeout' })
    expect(r.summary).toContain('ran out of time')
  })

  it('fails politely when no fixture matches', async () => {
    const r = await runAgent(request('something nobody scripted'), scripted())
    expect(r.verdict).toBe('failed')
    expect(r.summary).toContain('MORPHKIT_API_KEY')
  })

  it('does not report unchanged files and keeps base content for the others', async () => {
    const provider = scripted({ name: 'noop', turns: [{ calls: [{ tool: 'finish', input: { verdict: 'ok', summary: 'Nothing to change.' } }] }] })
    const r = await runAgent(request('noop'), provider)
    expect(r).toMatchObject({ verdict: 'ok', files: {} })
    expect(BASE_CARD).toContain('customer-card')
    expect(TABLE).toBe('src/dynamic/deals-table.tsx')
  })
})
