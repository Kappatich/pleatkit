import { describe, expect, it } from 'vitest'
import { costUsd } from '@pleatkit/runtime/compiler'
import { EnsembleProvider, jevDecides, labelOfRoute, settledOf } from '../src/classifier-ensemble.js'
import { cacheTtlFromEnv, ensembleFromEnv, providerFromEnv, tailFromEnv } from '../src/config.js'
import { runAgent, validateRequest } from '../src/loop.js'
import { buildPrompt, exportsOf, pointedFiles, relativeImports, tailOf, userMessage } from '../src/prompt.js'
import { usageOf } from '../src/providers/anthropic.js'
import { jevBody, parseJev, TypeSafeClassifier, type JevAnswer } from '../src/providers/typesafe.js'
import type { BackendQuote, Classification, ModelProvider, ModelTurn } from '../src/types.js'
import { CARD, GOOD_CARD, request, TABLE } from './helpers.js'

const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const jevUsage = { inputTokens: 600, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }

function jevAnswer(route: JevAnswer['route'], confidence: number, adversarial: number | null = 0.02): JevAnswer {
  return { route, confidence, probabilities: route ? { [route]: confidence } : {}, adversarial, usage: jevUsage, model: 'jev-1.13.0', ms: 5 }
}

/** An inner provider whose classifier takes `ms`, and which can quote a backend request. */
function inner(c: Partial<Classification>, ms = 30, quote?: Partial<BackendQuote>) {
  const calls = { classify: 0, quote: 0, start: 0 }
  const p: ModelProvider = {
    name: 'fake',
    model: 'big-model',
    async classify() {
      calls.classify++
      await sleep(ms)
      return { label: 'ui', reason: '', usage, model: 'claude-haiku-5-5', ...c } as Classification
    },
    async quoteBackend() {
      calls.quote++
      return { reason: 'This needs the server.', backendQuote: 'on the server', intentLabel: 'backend-calculation', gist: 'recalculate an amount on the server', usage, model: 'claude-haiku-5-5', ...quote }
    },
    start() {
      calls.start++
      let n = 0
      return {
        say: () => undefined,
        next: async (): Promise<ModelTurn> => {
          n++
          await sleep(60)
          const toolCalls = n === 1 ? [{ id: 'w', name: 'write_file', input: { path: CARD, content: GOOD_CARD } }, { id: 'f', name: 'finish', input: { verdict: 'ok', summary: 'Done.' } }] : []
          return { text: '', toolCalls, stop: 'tool_use', usage, model: 'big-model' }
        },
      }
    },
  }
  return { p, calls }
}

const router = (a: JevAnswer | Error, ms = 1) => ({
  calls: 0,
  async route() {
    this.calls++
    await sleep(ms)
    if (a instanceof Error) throw a
    return a
  },
})

const input = { request: 'Show the phone in the card', context: 'Editable UI panels: customer-card.' }

describe('block 6: the Jev rule (DECISIONS 83)', () => {
  it('decides ui, partial, needs-backend and restore at confidence >= 0.9 with a clean adversarial check', () => {
    for (const r of ['ui', 'partial', 'needs-backend', 'restore'] as const) expect(jevDecides(jevAnswer(r, 0.95), null)).toBe(true)
    expect(jevDecides(jevAnswer('ui', 0.89), null)).toBe(false)
    expect(jevDecides(jevAnswer('ui', 0.99, 0.2), null)).toBe(false)
    expect(jevDecides(jevAnswer('ui', 0.99, null), null)).toBe(false)
    for (const r of ['clarify', 'off-topic', 'declined', 'not-editable'] as const) expect(jevDecides(jevAnswer(r, 0.99), null)).toBe(false)
    expect(jevDecides(jevAnswer('ui', 0.99), { intentLabel: 'adversarial' })).toBe(false)
    expect(jevDecides(jevAnswer('ui', 0.99), { intentLabel: 'fields-add' })).toBe(true)
  })

  it('maps partial to the model label ui', () => {
    expect(labelOfRoute('partial')).toBe('ui')
    expect(labelOfRoute('restore')).toBe('restore')
    expect(labelOfRoute('clarify')).toBeNull()
  })
})

describe('block 6: the ensemble provider', () => {
  it('answers with Jev before the classifier model and hands the model answer to onLate', async () => {
    const { p } = inner({ label: 'ui', intentLabel: 'fields-add' }, 40)
    const e = new EnsembleProvider(p, router(jevAnswer('partial', 0.97)))
    const late: Classification[] = []
    const t0 = performance.now()
    const c = await e.classify({ ...input, onLate: (m) => late.push(m) }, AbortSignal.timeout(1000))
    expect(performance.now() - t0).toBeLessThan(35)
    expect(c.label).toBe('ui')
    expect(c.ensemble).toEqual({ decidedBy: 'jev', jev: { route: 'partial', confidence: 0.97, adversarial: 0.02, ms: 5 } })
    expect(c.usage).toBeNull()
    expect(c.extraUsage).toEqual([{ model: 'jev-1.13.0', usage: jevUsage }])
    expect(late).toHaveLength(0)
    // not serialized into a transcript
    expect(JSON.stringify(c)).not.toContain('settled')
    await settledOf(c)
    expect(late.map((m) => m.intentLabel)).toEqual(['fields-add'])
  })

  it('lets the classifier model decide when Jev is unsure, says clarify, errs or flags the request', async () => {
    for (const a of [jevAnswer('ui', 0.6), jevAnswer('clarify', 0.99), jevAnswer('ui', 0.99, 0.5), new Error('HTTP 500')]) {
      const { p } = inner({ label: 'unclear', question: 'Which?', options: ['a', 'b'] }, 5)
      const c = await new EnsembleProvider(p, router(a)).classify(input, AbortSignal.timeout(1000))
      expect(c.label).toBe('unclear')
      expect(c.ensemble?.decidedBy).toBe('model')
      expect(c.usage).toEqual(usage)
    }
  })

  it('does not wait for a slow Jev more than the grace after the classifier model', async () => {
    const { p } = inner({ label: 'ui', intentLabel: 'fields-add' }, 5)
    const late: Classification[] = []
    const t0 = performance.now()
    const c = await new EnsembleProvider(p, router(jevAnswer('ui', 0.99), 400), { graceMs: 20 }).classify({ ...input, onLate: (m) => late.push(m) }, AbortSignal.timeout(2000))
    expect(performance.now() - t0).toBeLessThan(200)
    expect(c.ensemble).toEqual({ decidedBy: 'model', jev: null })
    await sleep(450)
    expect(late.map((m) => m.model)).toEqual(['jev-1.13.0'])
  })

  it('skips Jev when the classifier model already answered adversarial', async () => {
    const { p } = inner({ label: 'off-topic', intentLabel: 'adversarial' }, 1)
    const c = await new EnsembleProvider(p, router(jevAnswer('partial', 0.95), 20)).classify(input, AbortSignal.timeout(1000))
    expect(c.ensemble?.decidedBy).toBe('model')
    expect(c.intentLabel).toBe('adversarial')
  })

  it('takes the text of a needs-backend decision from the classifier model, or from a quote follow-up', async () => {
    const same = inner({ label: 'needs-backend', reason: 'Server work.', backendQuote: 'recalculate on the server' }, 10)
    const c1 = await new EnsembleProvider(same.p, router(jevAnswer('needs-backend', 0.95))).classify(input, AbortSignal.timeout(1000))
    expect(c1).toMatchObject({ label: 'needs-backend', reason: 'Server work.', backendQuote: 'recalculate on the server', ensemble: { decidedBy: 'jev' } })
    expect(same.calls.quote).toBe(0)

    const other = inner({ label: 'ui', intentLabel: 'fields-add' }, 10)
    const c2 = await new EnsembleProvider(other.p, router(jevAnswer('needs-backend', 0.95))).classify(input, AbortSignal.timeout(1000))
    expect(other.calls.quote).toBe(1)
    expect(c2).toMatchObject({ label: 'needs-backend', reason: 'This needs the server.', backendQuote: 'on the server', intentLabel: 'backend-calculation' })
    // Jev, the classifier model and the follow-up are all metered
    expect(c2.extraUsage?.map((x) => x.model)).toEqual(['jev-1.13.0', 'claude-haiku-5-5', 'claude-haiku-5-5'])
  })

  it('runs an edit: Jev decides, the early call is used, Jev and the late classifier are metered', async () => {
    const { p } = inner({ label: 'ui', intentLabel: 'fields-add', gist: 'show an existing field' }, 20)
    const e = new EnsembleProvider(p, router(jevAnswer('ui', 0.98)))
    const r = await runAgent(request('Show the phone in the card'), e)
    expect(r.verdict).toBe('ok')
    expect(r.classifier).toEqual({ decidedBy: 'jev', jev: { route: 'ui', confidence: 0.98, adversarial: 0.02, ms: 5 } })
    expect(r.usage.map((u) => u.model).sort()).toEqual(['big-model', 'claude-haiku-5-5', 'jev-1.13.0'])
    expect(r.intentLabel).toBe('fields-add')
    expect(r.timings.classifyMs).toBeLessThan(20)
  })

  it('answers restore without a model call when Jev is sure', async () => {
    const { p, calls } = inner({ label: 'ui' }, 50)
    const r = await runAgent(request('Put the card back like it was'), new EnsembleProvider(p, router(jevAnswer('restore', 0.96))), { classifierMode: 'sequential' })
    expect(r.verdict).toBe('restore')
    expect(r.modelCalls).toBe(0)
    expect(calls.start).toBe(0)
  })
})

describe('block 6: TypeSafe request and answer', () => {
  it('sends the route choice and the adversarial noul with the panels and contract in the state', () => {
    const b = jevBody({ request: 'x', context: 'Editable UI panels: customer-card.' }) as { model: string; state: Record<string, string>; questions: Record<string, { type: string }> }
    expect(b.model).toBe('jev-latest')
    expect(b.state.panels_and_data).toContain('customer-card')
    expect(b.state.request).toBe('x')
    expect(b.questions.route!.type).toBe('choice')
    expect(b.questions.adversarial!.type).toBe('noul')
  })

  it('parses the answer and refuses an unknown route', () => {
    const a = parseJev({ model: 'jev-1.13.0', answers: { route: { choice: 'partial', confidence: 0.94, probabilities: { partial: 0.94, ui: 0.06 } }, adversarial: { noul: 0.03 } }, usage: { input_tokens: 512, output_tokens: 30 } }, 300)
    expect(a).toMatchObject({ route: 'partial', confidence: 0.94, adversarial: 0.03, model: 'jev-1.13.0', ms: 300 })
    expect(a.usage.inputTokens).toBe(512)
    expect(parseJev({ answers: { route: { choice: 'banana', confidence: 1 } } }, 1)).toMatchObject({ route: null, confidence: 0, adversarial: null })
  })

  it('calls the API with a bearer key and never puts the key in an error', async () => {
    let auth = ''
    const ok = new TypeSafeClassifier({ apiKey: 'ts-secret', fetch: (async (_u: string, init: RequestInit) => {
      auth = (init.headers as Record<string, string>).authorization!
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { route: { choice: 'ui', confidence: 1 }, adversarial: { noul: 0 } }, usage: { input_tokens: 10 } }))
    }) as typeof fetch })
    expect((await ok.route(input, AbortSignal.timeout(1000))).route).toBe('ui')
    expect(auth).toBe('Bearer ts-secret')
    const bad = new TypeSafeClassifier({ apiKey: 'ts-secret', fetch: (async () => new Response('no', { status: 401 })) as typeof fetch })
    await expect(bad.route(input, AbortSignal.timeout(1000))).rejects.toThrow(/HTTP 401/)
    await bad.route(input, AbortSignal.timeout(1000)).catch((e: Error) => expect(e.message).not.toContain('ts-secret'))
  })

  it('prices Jev input at $0.042 per million and its output at zero', () => {
    expect(costUsd('jev-1.13.0', { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeCloseTo(0.042, 6)
  })
})

describe('block 6: configuration', () => {
  it('turns the ensemble on only with the key; an explicit jev without the key is an error', () => {
    expect(ensembleFromEnv({})).toBeNull()
    expect(ensembleFromEnv({ PLEATKIT_CLASSIFIER_ENSEMBLE: 'off', TYPESAFE_API_KEY: 'k' })).toBeNull()
    expect(ensembleFromEnv({ PLEATKIT_CLASSIFIER_ENSEMBLE: 'jev', TYPESAFE_API_KEY: 'k' })).toBeInstanceOf(TypeSafeClassifier)
    expect(() => ensembleFromEnv({ PLEATKIT_CLASSIFIER_ENSEMBLE: 'jev' })).toThrow(/TYPESAFE_API_KEY/)
    expect(() => ensembleFromEnv({ PLEATKIT_CLASSIFIER_ENSEMBLE: 'maybe' })).toThrow(/off or jev/)
  })

  it('wraps a model provider but never the scripted one', () => {
    expect(providerFromEnv({ PLEATKIT_API_KEY: 'a', PLEATKIT_CLASSIFIER_ENSEMBLE: 'jev', TYPESAFE_API_KEY: 'k' })).toBeInstanceOf(EnsembleProvider)
    expect(providerFromEnv({ PLEATKIT_PROVIDER: 'scripted', PLEATKIT_CLASSIFIER_ENSEMBLE: 'jev', TYPESAFE_API_KEY: 'k' })).not.toBeInstanceOf(EnsembleProvider)
  })

  it('reads PLEATKIT_TAIL and PLEATKIT_CACHE_TTL', () => {
    expect(tailFromEnv(undefined)).toBe('pointed')
    expect(tailFromEnv('all')).toBe('all')
    expect(() => tailFromEnv('some')).toThrow()
    expect(cacheTtlFromEnv('')).toBeUndefined()
    expect(cacheTtlFromEnv('1h')).toBe('1h')
    expect(() => cacheTtlFromEnv('2h')).toThrow()
  })
})

describe('block 6: the 1-hour cache TTL (17 §21)', () => {
  it('reads the 1-hour share of the cache writes and prices it at 2x input', () => {
    const u = usageOf({ input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 } })
    expect(u.cacheWrite1hTokens).toBe(1000)
    // Sonnet 5.5: 1,000 tokens written for an hour = 1,000 × $4/M, plus 10 input × $2/M
    expect(costUsd('claude-sonnet-5-5', u)).toBeCloseTo(0.004 + 0.00002, 8)
    expect(costUsd('claude-sonnet-5-5', { ...u, cacheWrite1hTokens: 0 })).toBeCloseTo(0.0025 + 0.00002, 8)
  })
})

describe('block 6: the pointed panel tail (DECISIONS 84.5)', () => {
  const files = {
    'src/dynamic/users-table.tsx': `import { columns } from './users-columns'\nimport styles from './users.module.css'\nexport default function UsersTable() { return <table className={styles.t} /> }\n`,
    'src/dynamic/users-columns.tsx': `import { Badge } from './ui/badge'\nexport const columns = []\n`,
    'src/dynamic/ui/badge.tsx': `export function Badge() { return null }\n`,
    'src/dynamic/users.module.css': `.t { color: red }\n`,
    'src/dynamic/tasks-table.tsx': `export default function TasksTable() { return <table /> }\nexport type Task = { id: string }\n`,
    'src/dynamic/stats.tsx': `const Stats = () => null\nexport { Stats as default, Stats }\n`,
  }
  const req = request('Make the users table compact', { files, components: ['src/dynamic/users-table.tsx', 'src/dynamic/tasks-table.tsx', 'src/dynamic/stats.tsx'], target: 'users-table' })

  it('follows relative imports transitively, CSS included', () => {
    expect(relativeImports(files['src/dynamic/users-table.tsx'])).toEqual(['./users-columns', './users.module.css'])
    expect(pointedFiles(req)).toEqual(['src/dynamic/ui/badge.tsx', 'src/dynamic/users-columns.tsx', 'src/dynamic/users-table.tsx', 'src/dynamic/users.module.css'])
  })

  it('lists the other files by name and exports', () => {
    expect(exportsOf(files['src/dynamic/tasks-table.tsx'])).toEqual(['default', 'Task'])
    expect(exportsOf(files['src/dynamic/stats.tsx'])).toEqual(['default', 'Stats'])
    const t = tailOf(req)
    expect(Object.keys(t.files)).toHaveLength(4)
    expect(t.others).toEqual(['- src/dynamic/stats.tsx (3 lines; exports default, Stats)', '- src/dynamic/tasks-table.tsx (3 lines; exports default, Task)'])
    const msg = userMessage(req)
    expect(msg).toContain('Other files of the dynamic zone, not shown above')
    expect(msg).not.toContain('export default function TasksTable')
  })

  it('sends every file without a pointed panel, with PLEATKIT_TAIL=all, for a migration and for an unknown target', () => {
    expect(tailOf({ ...req, target: undefined }).others).toEqual([])
    expect(tailOf(req, 'all').others).toEqual([])
    expect(tailOf({ ...req, migration: { oldBase: {}, edited: {} } }).others).toEqual([])
    expect(tailOf({ ...req, target: 'nope' }).others).toEqual([])
    expect(userMessage(request('x', { target: 'customer-card' }))).toContain(`<file path="${TABLE}">`.replace(TABLE, CARD))
  })
})

describe('block 6: the pointed panel screenshot (17 §14)', () => {
  const png = { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' }

  it('goes after the user images with one sentence, only with a target', () => {
    const p = buildPrompt(request('Make it compact', { target: 'customer-card', targetImage: png, images: [{ ...png, name: 'mine' }] }))
    expect(p.images).toHaveLength(2)
    expect(p.images![1]).toBe(png)
    expect(p.user).toContain('The last image above is a screenshot of the panel "customer-card"')
    expect(buildPrompt(request('x', { targetImage: png })).images).toBeUndefined()
  })

  it('is validated with the image limits', () => {
    const body = { ...request('x', { target: 'customer-card' }), targetImage: png }
    expect(validateRequest(body).targetImage).toEqual(png)
    expect(() => validateRequest({ ...body, targetImage: { mediaType: 'image/bmp', data: 'AA==' } })).toThrow(/mediaType/)
  })
})
