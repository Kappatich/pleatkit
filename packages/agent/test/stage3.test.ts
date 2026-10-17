/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect raw JSON wire payloads */
import { describe, expect, it } from 'vitest'
import type { AgentProgress } from '@morphkit/runtime/compiler'
import { t } from '../src/i18n.js'
import { runAgent, visibleOutputTokens } from '../src/loop.js'
import { AnthropicProvider, MAX_TOKENS_PER_CALL } from '../src/providers/anthropic.js'
import { CARD, GOOD_CARD, request, scripted } from './helpers.js'

const listTurn = (outputTokens: number, thinkingTokens?: number) => ({
  usage: { outputTokens, ...(thinkingTokens === undefined ? {} : { thinkingTokens }) },
  calls: [{ tool: 'list_files', input: {} }],
})
const finishTurn = { calls: [{ tool: 'finish', input: { verdict: 'ok', summary: 'Done.' } }] }

describe('output budget counts visible tokens only (DECISIONS 11)', () => {
  it('a run whose thinking alone exceeds the budget still finishes', async () => {
    // 3 × 6000 output tokens, of which 5800 thinking: 18k output, 600 visible
    const provider = scripted({ name: 'thinker', turns: [listTurn(6000, 5800), listTurn(6000, 5800), listTurn(6000, 5800), finishTurn] })
    const r = await runAgent(request('thinker'), provider, { limits: { maxOutputTokens: 8000 } })
    expect(r.verdict).toBe('ok')
    expect(r.output).toEqual({ visibleTokens: 600, thinkingTokens: 17_400, limit: 8000, estimated: false })
    expect(r.usage.find((u) => u.model === 'scripted:thinker')).toMatchObject({ outputTokens: 18_000, thinkingTokens: 17_400 })
  })

  it('stops once the visible output reaches the budget, with a plain-language summary', async () => {
    const provider = scripted({ name: 'writer', turns: [listTurn(700, 100), listTurn(700, 100), listTurn(700, 100), finishTurn] })
    const r = await runAgent(request('writer'), provider, { limits: { maxOutputTokens: 1000 } })
    expect(r).toMatchObject({ verdict: 'failed', stopReason: 'output-tokens', modelCalls: 2 })
    expect(r.output?.visibleTokens).toBe(1200)
    expect(r.summary).not.toMatch(/token/i)
  })

  it('estimates visible tokens from the content when the API does not report thinking', () => {
    const turn = { text: '', toolCalls: [{ id: '1', name: 'write_file', input: { path: CARD, content: GOOD_CARD } }], usage: { inputTokens: 0, outputTokens: 5000, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    const v = visibleOutputTokens(turn)
    expect(v.estimated).toBe(true)
    expect(v.tokens).toBeGreaterThan(50)
    expect(v.tokens).toBeLessThan(300)
    expect(visibleOutputTokens({ ...turn, usage: { ...turn.usage, thinkingTokens: 4900 } })).toEqual({ tokens: 100, estimated: false })
  })

  it('Anthropic: max_tokens leaves room for thinking, thinking_tokens come from output_tokens_details', async () => {
    const calls: any[] = []
    const fetch = (async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)))
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'finish', input: { verdict: 'ok', summary: 'Nothing to change.' } }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 3000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens_details: { thinking_tokens: 2950 } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof globalThis.fetch
    const provider = new AnthropicProvider({ apiKey: 'k', baseURL: 'http://anthropic.test', fetch })
    const r = await runAgent(request('noop'), provider, { classify: false })
    expect(calls[0].max_tokens).toBe(MAX_TOKENS_PER_CALL)
    expect(r.output).toEqual({ visibleTokens: 50, thinkingTokens: 2950, limit: 8000, estimated: false })
  })
})

describe('classifier (DECISIONS 17)', () => {
  const fixture = { name: 'discount', classify: { label: 'needs-backend' as const, reason: 'Server work.' }, turns: [finishTurn] }

  it('runs when the user typed a request', async () => {
    const r = await runAgent(request('discount'), scripted(fixture))
    expect(r).toMatchObject({ verdict: 'needs-backend', classification: 'needs-backend', modelCalls: 0 })
  })

  it('is skipped when the user pointed at a panel', async () => {
    const events: AgentProgress[] = []
    const r = await runAgent(request('[panel: customer-card] discount', { target: 'customer-card' }), scripted(fixture), { onProgress: (p) => events.push(p) })
    expect(r).toMatchObject({ verdict: 'ok', classification: null, modelCalls: 1 })
    expect(r.timings.classifyMs).toBeNull()
    expect(events.map((e) => e.type)).not.toContain('classified')
    expect(events[0]).toMatchObject({ type: 'model', text: 'Planning the change' })
  })
})

describe('progress lines', () => {
  it('"Thinking" between tool calls is marked transient, the first planning line is not', async () => {
    const events: AgentProgress[] = []
    await runAgent(request('three'), scripted({ name: 'three', turns: [listTurn(0), listTurn(0), finishTurn] }), { onProgress: (p) => events.push(p) })
    const model = events.filter((e) => e.type === 'model')
    expect(model.map((e) => [e.text, 'transient' in e && e.transient === true])).toEqual([
      ['Planning the change', false],
      ['Thinking', true],
      ['Thinking', true],
    ])
  })

  it('come in Russian for locale ru (DECISIONS 20), still without code or file names', async () => {
    const provider = scripted({
      name: 'phone',
      turns: [
        { calls: [{ tool: 'read_file', input: { path: CARD } }] },
        { calls: [{ tool: 'write_file', input: { path: CARD, content: GOOD_CARD } }, { tool: 'check', input: {} }] },
        finishTurn,
      ],
    })
    const events: string[] = []
    await runAgent(request('phone', { locale: 'ru' }), provider, { onProgress: (p) => events.push(p.text) })
    expect(events).toEqual(
      expect.arrayContaining([t('ru', 'understanding'), 'Смотрю панель «customer card»', 'Меняю панель «customer card»', t('ru', 'checking'), t('ru', 'checkOk')]),
    )
    for (const e of events) expect(e).not.toMatch(/\.tsx?\b|src\/|=>|<\w/)
  })

  it('the Russian dictionary has every key of the English one', async () => {
    const { MESSAGES } = await import('../src/i18n.js')
    expect(Object.keys(MESSAGES.ru).sort()).toEqual(Object.keys(MESSAGES.en).sort())
  })

  it('a failed model call shows the user a plain sentence; the technical error goes to the result for the admin', async () => {
    const provider = scripted({ name: 'boom', turns: [] })
    provider.start = () => ({
      say: () => undefined,
      next: () => Promise.reject(new Error('socket hang up at 10.0.0.1:443')),
    })
    const r = await runAgent(request('boom'), provider)
    expect(r).toMatchObject({ verdict: 'failed', stopReason: 'error', error: 'socket hang up at 10.0.0.1:443' })
    expect(r.summary).toBe(t('en', 'agentFailed'))
  })
})
