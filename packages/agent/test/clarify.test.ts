/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect raw JSON wire payloads */
import { describe, expect, it } from 'vitest'
import type { AgentProgress } from '@pleatkit/runtime/compiler'
import { runAgent, validateRequest } from '../src/loop.js'
import { buildPrompt } from '../src/prompt.js'
import { AnthropicProvider, clarifyOf } from '../src/providers/anthropic.js'
import { CARD, GOOD_CARD, request, scripted } from './helpers.js'

const ambiguous = {
  name: 'stand out',
  classify: { label: 'unclear' as const, reason: 'Not clear what.', question: 'What should stand out?', options: ['The overdue date', 'The status'] },
  turns: [
    { calls: [{ tool: 'write_file', input: { path: CARD, content: GOOD_CARD } }, { tool: 'check', input: {} }] },
    { calls: [{ tool: 'finish', input: { verdict: 'ok', summary: 'Done.' } }] },
  ],
}

describe('one clarifying question (stage 3b)', () => {
  it('an unclear request returns the question with options; nothing is written and the big model is not called', async () => {
    const provider = scripted(ambiguous)
    const events: AgentProgress[] = []
    // sequential classifier: the big model is never started (the parallel mode starts and cancels it: parallel-classifier.test.ts)
    const r = await runAgent(request('make it stand out'), provider, { classifierMode: 'sequential', onProgress: (p) => events.push(p) })
    expect(r).toMatchObject({ verdict: 'clarify', summary: 'What should stand out?', clarify: { question: 'What should stand out?', options: ['The overdue date', 'The status'] }, modelCalls: 0, files: {} })
    expect(provider.received).toHaveLength(0)
    expect(events.find((e) => e.type === 'classified')?.text).toBe('I need one detail first')
  })

  it('with the answer, the classifier is skipped (never a second question) and the answer is in the prompt', async () => {
    const provider = scripted(ambiguous)
    const clarification = { question: 'What should stand out?', answer: 'The overdue date' }
    const r = await runAgent(request('make it stand out', { clarification }), provider)
    expect(r).toMatchObject({ verdict: 'ok', classification: null })
    expect(Object.keys(r.files)).toEqual([CARD])
    expect(buildPrompt(request('make it stand out', { clarification })).user).toContain('They answered: "The overdue date"')
  })

  it('unclear without a usable question just goes ahead', async () => {
    const provider = scripted({ ...ambiguous, classify: { label: 'unclear', reason: '' } })
    expect((await runAgent(request('make it stand out'), provider)).verdict).toBe('ok')
  })

  it('cleans up the classifier output: 2 to 4 non-empty options, otherwise no question', () => {
    expect(clarifyOf({ question: ' Which? ', options: ['a', ' ', 'b', 'c', 'd', 'e'] })).toEqual({ question: 'Which?', options: ['a', 'b', 'c', 'd'] })
    expect(clarifyOf({ question: 'Which?', options: ['only one'] })).toEqual({})
    expect(clarifyOf({ question: '', options: ['a', 'b'] })).toEqual({})
  })

  it('validates the clarification on the wire', () => {
    const base = JSON.parse(JSON.stringify(request('x'))) as Record<string, unknown>
    expect(validateRequest({ ...base, clarification: { question: 'Q?', answer: 'A' } }).clarification).toEqual({ question: 'Q?', answer: 'A' })
    expect(() => validateRequest({ ...base, clarification: { question: 'Q?', answer: ' ' } })).toThrow(/clarification/)
  })

  it('Anthropic: the classifier schema asks for question and options', async () => {
    const calls: any[] = []
    const fetch = (async (_u: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)))
      const text = JSON.stringify({ label: 'unclear', reason: 'Which part?', question: 'Which part should change?', options: ['The card', 'The table'] })
      return new Response(
        JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof globalThis.fetch
    const r = await runAgent(request('change it'), new AnthropicProvider({ apiKey: 'k', baseURL: 'http://anthropic.test', fetch }), { classifierMode: 'sequential' })
    expect(calls[0].output_config.format.schema.required).toEqual(['label', 'reason', 'question', 'options', 'intent_label', 'gist'])
    expect(calls).toHaveLength(1)
    expect(r.clarify).toEqual({ question: 'Which part should change?', options: ['The card', 'The table'] })
  })
})
