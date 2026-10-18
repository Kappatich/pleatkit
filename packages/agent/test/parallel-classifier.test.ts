import { describe, expect, it } from 'vitest'
import type { RequestClass } from '@pleatkit/runtime/compiler'
import { classifierBackendNote, runAgent } from '../src/loop.js'
import type { Classification, ModelProvider, ModelTurn } from '../src/types.js'
import { CARD, GOOD_CARD, request } from './helpers.js'

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new Error('aborted'))
    })
  })

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }

/** A provider whose classifier and main model take time, and that notes when each started and whether it was cancelled. */
function timed(label: RequestClass, o: { classifyMs: number; turnMs: number; extra?: Partial<Classification> }) {
  const events: { what: string; at: number }[] = []
  const t0 = performance.now()
  const note = (what: string) => events.push({ what, at: performance.now() - t0 })
  let aborted = false
  let turn = 0
  const provider: ModelProvider = {
    name: 'timed',
    model: 'big-model',
    async classify(): Promise<Classification> {
      note('classify')
      await sleep(o.classifyMs)
      note('classified')
      return { label, reason: 'This needs a change on the server.', gist: 'store a new persisted field', intentLabel: 'backend-field', usage, model: 'small-model', ...o.extra }
    },
    start() {
      note('start')
      return {
        say: () => undefined,
        next: async (_r, opts): Promise<ModelTurn> => {
          note(`turn ${turn + 1}`)
          opts.signal.addEventListener('abort', () => void (aborted = true))
          await sleep(o.turnMs, opts.signal)
          turn++
          const calls =
            turn === 1
              ? [{ id: 'w', name: 'write_file', input: { path: CARD, content: GOOD_CARD } }, { id: 'f', name: 'finish', input: { verdict: 'ok', summary: 'Done.' } }]
              : [{ id: 'f2', name: 'finish', input: { verdict: 'ok', summary: 'Done.' } }]
          return { text: '', toolCalls: calls, stop: 'tool_use', usage, model: 'big-model' }
        },
      }
    },
  }
  return { provider, events, wasAborted: () => aborted }
}

describe('DECISIONS 73.3: the classifier and the main model start together', () => {
  it('an edit: the first call runs while the classifier decides, and its answer is used', async () => {
    const { provider, events } = timed('ui', { classifyMs: 150, turnMs: 150 })
    const r = await runAgent(request('show the phone'), provider)
    expect(r.verdict).toBe('ok')
    expect(Object.keys(r.files)).toEqual([CARD])
    expect(r.modelCalls).toBe(1)
    // the main model started before the classifier answered
    const at = (w: string) => events.find((e) => e.what === w)!.at
    expect(at('start')).toBeLessThan(at('classified'))
    expect(events.filter((e) => e.what.startsWith('turn')).length).toBe(1)
    // side by side: the first call ran for most of the classifier's time, and the run took less than both in a row
    // (relative bounds: a loaded test machine stretches both waits)
    expect(r.timings.overlapMs).toBeGreaterThan(0.5 * Math.min(r.timings.classifyMs!, r.timings.modelMs))
    expect(r.timings.totalMs - r.timings.toolsMs).toBeLessThan(r.timings.classifyMs! + r.timings.modelMs)
  })

  it('sequential mode waits for the classifier (the comparison for the saved time)', async () => {
    const { provider, events } = timed('ui', { classifyMs: 120, turnMs: 120 })
    const r = await runAgent(request('show the phone'), provider, { classifierMode: 'sequential' })
    expect(r.verdict).toBe('ok')
    expect(events.find((e) => e.what === 'start')!.at).toBeGreaterThanOrEqual(events.find((e) => e.what === 'classified')!.at)
    expect(r.timings.overlapMs).toBeUndefined()
    expect(r.timings.totalMs).toBeGreaterThanOrEqual(r.timings.classifyMs! + r.timings.modelMs - 5)
  })

  it('needs-backend: the early call is cancelled, nothing is written, the administrator gets a backend note', async () => {
    const { provider, wasAborted } = timed('needs-backend', { classifyMs: 30, turnMs: 500 })
    const r = await runAgent(request('apply a discount on the server'), provider)
    expect(r).toMatchObject({ verdict: 'needs-backend', modelCalls: 0, files: {}, summary: 'This needs a change on the server.' })
    expect(wasAborted()).toBe(true)
    expect(r.backendNote).toBe('Needs server work: store a new persisted field (backend-field). The user was told: "This needs a change on the server."')
    // only the classifier's call is billed in the result: the cancelled call reports no usage
    expect(r.usage.map((u) => u.model)).toEqual(['small-model'])
  })

  it('a question and an off-topic request cancel the early call too', async () => {
    const ask = timed('unclear', { classifyMs: 20, turnMs: 500, extra: { question: 'Which part?', options: ['A', 'B'] } })
    expect((await runAgent(request('make it pop'), ask.provider)).verdict).toBe('clarify')
    expect(ask.wasAborted()).toBe(true)
    const off = timed('off-topic', { classifyMs: 20, turnMs: 500, extra: { intentLabel: 'adversarial' } })
    expect((await runAgent(request('a fake login form'), off.provider)).verdict).toBe('declined')
    expect(off.wasAborted()).toBe(true)
  })

  it('a pointed request skips the classifier and starts the main model at once (as before)', async () => {
    const { provider, events } = timed('needs-backend', { classifyMs: 30, turnMs: 20 })
    const r = await runAgent(request('make it red', { target: 'customer-card' }), provider)
    expect(r.verdict).toBe('ok')
    expect(events.some((e) => e.what === 'classify')).toBe(false)
    expect(r.timings.overlapMs).toBeUndefined()
  })

  it('classifierBackendNote: gist and intent for the administrator, the user\'s sentence quoted', () => {
    expect(classifierBackendNote({ gist: 'recalculate deal amount on the server.', intentLabel: 'backend-calculation', reason: 'Нужен сервер.' })).toBe(
      'Needs server work: recalculate deal amount on the server (backend-calculation). The user was told: "Нужен сервер."',
    )
    expect(classifierBackendNote({ reason: 'Needs the server.' })).toBe('Needs server work. The user was told: "Needs the server."')
    expect(classifierBackendNote({ reason: '' })).toBeUndefined()
  })
})
