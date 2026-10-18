import { describe, expect, it } from 'vitest'
import { runAgent } from '../src/loop.js'
import { cacheHitRate } from '../src/pricing.js'
import { BASE_CARD, CARD, GOOD_CARD, request, scripted } from './helpers.js'

describe('brainstorm 04 §8 item 5: edit_file and the automatic check', () => {
  it('edit_file replaces one unique occurrence; the check runs by itself after the turn', async () => {
    const provider = scripted({
      name: 'edit',
      turns: [
        { calls: [{ tool: 'edit_file', input: { path: CARD, old_str: '{customer.name}</div>', new_str: '{customer.name} <b>VIP</b></div>' }, expect: 'ok' }] },
        { calls: [{ tool: 'finish', input: { verdict: 'ok', summary: 'Marked VIP.' }, expect: 'ok' }] },
      ],
    })
    const r = await runAgent(request('edit'), provider)
    expect(r.verdict).toBe('ok')
    expect(r.files[CARD]).toBe(BASE_CARD.replace('{customer.name}</div>', '{customer.name} <b>VIP</b></div>'))
    const edit = r.log.find((l) => l.tool === 'edit_file')!
    expect(edit.input).toMatchObject({ path: CARD, oldBytes: 21 })
    expect(r.modelCalls).toBe(2)
    expect(r.log.some((l) => l.tool === 'check')).toBe(false)
  })

  it('a missing or ambiguous old_str is an error with the closest lines', async () => {
    const provider = scripted({
      name: 'miss',
      turns: [
        { calls: [{ tool: 'edit_file', input: { path: CARD, old_str: 'customer.nam}</span>', new_str: 'x' }, expect: 'error' }] },
        { calls: [{ tool: 'edit_file', input: { path: CARD, old_str: 'customer', new_str: 'x' }, expect: 'error' }] },
        { calls: [{ tool: 'finish', input: { verdict: 'failed', summary: 'x' } }] },
      ],
    })
    const r = await runAgent(request('miss'), provider)
    const [a, b] = r.log.filter((l) => l.tool === 'edit_file')
    expect(a!.result).toMatch(/not found.*Closest lines/s)
    expect(b!.result).toMatch(/occurs \d+ times/)
  })

  it('the automatic check result reaches the model with its write', async () => {
    let seen = ''
    const provider = scripted({
      name: 'auto',
      turns: [
        { calls: [{ tool: 'write_file', input: { path: CARD, content: 'export default function C() { return <div><span></div> }' } }] },
        { calls: [{ tool: 'write_file', input: { path: CARD, content: GOOD_CARD } }] },
        { calls: [{ tool: 'finish', input: { verdict: 'ok', summary: 'Done.' } }] },
      ],
    })
    const orig = provider.start.bind(provider)
    provider.start = (p, t, m) => {
      const s = orig(p, t, m)
      return { ...s, next: async (results, o) => ((seen += results.map((x) => x.content).join('\n')), s.next(results, o)) }
    }
    const r = await runAgent(request('auto'), provider)
    expect(r.verdict).toBe('ok')
    expect(seen).toMatch(/Automatic check after this turn: FAILED/)
    expect(seen).toMatch(/Automatic check after this turn: OK/)
  })
})

describe('brainstorm 04 §8 item 6: verdicts and one clarification from the main loop', () => {
  it('partial applies the screen part and carries the backend note', async () => {
    const provider = scripted({
      name: 'part',
      turns: [{ calls: [{ tool: 'write_file', input: { path: CARD, content: GOOD_CARD } }, { tool: 'finish', input: { verdict: 'partial', summary: 'Shown; saving needs the server.', backend_note: 'store phone history' } }] }],
    })
    const r = await runAgent(request('part'), provider)
    expect(r).toMatchObject({ verdict: 'partial', backendNote: 'store phone history' })
    expect(r.files[CARD]).toBe(GOOD_CARD)
  })

  it('clarify asks once; after an answer it is refused', async () => {
    const ask = { tool: 'finish', input: { verdict: 'clarify', summary: '', question: 'Which date?', options: ['Due date', 'Created'] } }
    const first = await runAgent(request('ask'), scripted({ name: 'ask', turns: [{ calls: [ask] }] }))
    expect(first).toMatchObject({ verdict: 'clarify', clarify: { question: 'Which date?', options: ['Due date', 'Created'] } })
    const again = await runAgent(
      request('ask', { clarification: { question: 'Which date?', answer: 'Due date' } }),
      scripted({ name: 'ask', turns: [{ calls: [{ ...ask, expect: 'error' as const }] }, { calls: [{ tool: 'finish', input: { verdict: 'failed', summary: 'x' } }] }] }),
    )
    expect(again.verdict).toBe('failed')
    expect(again.log[0]!.result).toMatch(/already answered/)
  })

  it('not-editable and declined change nothing', async () => {
    for (const verdict of ['not-editable', 'declined']) {
      const r = await runAgent(request('no'), scripted({ name: 'no', turns: [{ calls: [{ tool: 'write_file', input: { path: CARD, content: GOOD_CARD } }, { tool: 'finish', input: { verdict, summary: 'No.' } }] }] }))
      expect(r.verdict).toBe(verdict)
      expect(r.files).toEqual({})
    }
  })
})

describe('brainstorm 04 §5: cache hit rate', () => {
  it('is cache reads over all input of the run', () => {
    expect(cacheHitRate([{ calls: 3, inputTokens: 1000, cacheWriteTokens: 1000, cacheReadTokens: 8000 }])).toBe(0.8)
    expect(cacheHitRate([])).toBeNull()
  })
})

describe('brainstorm 04 §8 items 2 and 11: recorded transcripts replay without a model', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { RecordingProvider, ReplayProvider, readTranscript } = await import('../src/providers/recording.js')
  it('records the full write content, the prompt version and usage; the replay gives the same result', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-rec-'))
    const live = scripted({ name: 'rec', turns: [{ calls: [{ tool: 'write_file', input: { path: CARD, content: GOOD_CARD } }] }, { calls: [{ tool: 'finish', input: { verdict: 'ok', summary: 'Done.' } }] }] })
    const rec = new RecordingProvider(live, { dir, taskId: 'demo-01' })
    const first = await runAgent(request('rec'), rec)
    const lines = readTranscript(rec.files[0]!)
    expect(lines[0]).toMatchObject({ kind: 'meta', promptVersion: expect.any(String), taskId: 'demo-01' })
    expect(lines.some((l) => l.kind === 'classify')).toBe(true)
    expect(JSON.stringify(lines)).toContain(JSON.stringify(GOOD_CARD))
    const second = await runAgent(request('rec'), new ReplayProvider(rec.files[0]!))
    expect(second.verdict).toBe(first.verdict)
    expect(second.files).toEqual(first.files)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('DECISIONS 42 and 44: runs by Idempotency-Key in store-server; L1 facts (the cloud module), HMAC keys, retention', async () => {
  const { createStoreApp, openStore } = await import('../../store-server/src/app.js')
  const { applyRetention } = await import('../../store-server/src/retention.js')
  const { learningExtension, applyFactsRetention, cloudSchema } = await import('../../store-cloud/src/index.js')
  const { createAgentApp } = await import('../src/server.js')
  const { schema } = await import('../../store-server/src/index.js')
  const setup = () => {
    const opened = openStore()
    const store = createStoreApp(opened.db, { extensions: [learningExtension({ learning: 'aggregate' })] })
    const fetchVia = ((input: string | URL | Request, init?: RequestInit) => store.request(String(input), init)) as typeof fetch
    return { ...opened, store, fetchVia }
  }
  const run = async (app: ReturnType<typeof createAgentApp>, key: string) => {
    const res = await app.request('/agent/v1/run', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(request('facts', { appId: 'crm' })) })
    return JSON.parse(/event: result\ndata: (.*)/.exec(await res.text())![1]!) as { verdict: string; requestId: string }
  }
  const provider = () =>
    scripted({ name: 'facts', classify: { label: 'ui', intentLabel: 'fields-add', gist: 'add phone to card 2' }, turns: [{ calls: [{ tool: 'write_file', input: { path: CARD, content: GOOD_CARD } }, { tool: 'finish', input: { verdict: 'ok', summary: 'Done.' } }] }] })

  it('a retry on another agent instance gets the first result, the model runs once', async () => {
    const t = setup()
    const p1 = provider()
    const p2 = provider()
    const a1 = createAgentApp({ provider: p1, log: () => undefined, storeUrl: 'http://store.test', fetch: t.fetchVia })
    const a2 = createAgentApp({ provider: p2, log: () => undefined, storeUrl: 'http://store.test', fetch: t.fetchVia })
    const first = await run(a1, 'k-1')
    const second = await run(a2, 'k-1')
    expect(second.requestId).toBe(first.requestId)
    expect(p1.received).toHaveLength(1)
    expect(p2.received).toHaveLength(0)
  })

  it('writes a fingerprint without text, with HMAC keys; retention blanks text and deletes old facts', async () => {
    const t = setup()
    const app = createAgentApp({ provider: provider(), log: () => undefined, storeUrl: 'http://store.test', fetch: t.fetchVia })
    const { requestId } = await run(app, 'k-2')
    const fact = t.db.select().from(cloudSchema.requestFacts).all()[0]!
    expect(fact).toMatchObject({ requestId, intentLabel: 'fields-add', verdict: 'ok', learning: 'aggregate', staticRuleHits: [] })
    expect(fact.userKey).not.toContain('alice')
    expect(JSON.stringify(fact)).not.toMatch(/alice|customer-card|phone/)
    const req = t.db.select().from(schema.requests).all()[0]!
    expect(req).toMatchObject({ intentLabel: 'fields-add', gist: 'add phone to card #' })
    const later = Date.now() + 600 * 86_400_000
    expect(applyRetention(t.db, later)).toMatchObject({ text: 1, logs: 1 })
    expect(applyFactsRetention(t.db, later)).toEqual({ facts: 1 })
    expect(t.db.select().from(schema.requests).all()[0]).toMatchObject({ text: '', target: null, gist: null, log: [] })
  })

  it('learning off (the default, and the only mode of the open core) writes no facts', async () => {
    const opened = openStore()
    const store = createStoreApp(opened.db, { extensions: [learningExtension()] })
    const fetchVia = ((input: string | URL | Request, init?: RequestInit) => store.request(String(input), init)) as typeof fetch
    await run(createAgentApp({ provider: provider(), log: () => undefined, storeUrl: 'http://store.test', fetch: fetchVia }), 'k-3')
    expect(opened.db.select().from(cloudSchema.requestFacts).all()).toHaveLength(0)
  })
})

describe('brainstorm 04 §1: digests in the cached prefix, byte-stable', async () => {
  const { buildPrompt } = await import('../src/prompt.js')
  it('puts the design system and data contracts before the sources, identically for two requests', () => {
    const digests = { designSystem: { digest: 'src/components/ui/button: Button(variant?: "default")' }, dataContracts: { digest: 'interface Customer { id: string }' } }
    const a = buildPrompt(request('one'), undefined, digests)
    const b = buildPrompt(request('two, other text'), undefined, digests)
    expect(a.cached).toBe(b.cached)
    expect(a.instructions).toBe(b.instructions)
    expect(a.cached.indexOf('<design_system>')).toBeLessThan(a.cached.indexOf('<readonly_sources>'))
    expect(a.cached).toContain('<data_contracts>')
  })
})
