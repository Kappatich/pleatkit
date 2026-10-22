/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect raw JSON wire payloads */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { providerFromEnv } from '../src/config.js'
import { runAgent } from '../src/loop.js'
import { OpenAICompatibleProvider, openAIUsageOf } from '../src/providers/openai.js'
import { SplitProvider } from '../src/providers/split.js'
import { UsageMeter } from '../src/pricing.js'
import { CARD, GOOD_CARD, request } from './helpers.js'

interface Seen {
  path: string
  headers: http.IncomingHttpHeaders
  body: Record<string, any>
}

/** A real HTTP server on 127.0.0.1 that answers from `answer` and records every request (the "fake server"). */
async function fakeServer(answer: (body: Record<string, any>, seen: Seen[]) => { status?: number; json: unknown }): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, any>) : {}
      seen.push({ path: req.url ?? '', headers: req.headers, body })
      const a = answer(body, seen)
      res.writeHead(a.status ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(a.json))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  servers.push(server)
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}
const servers: http.Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

const chat = (message: unknown, finish_reason: string, usage: Record<string, unknown> = {}, model = 'openai/gpt-5-mini') => ({ model, choices: [{ message, finish_reason }], usage: { prompt_tokens: 1000, completion_tokens: 50, ...usage } })
const toolCall = (id: string, name: string, args: unknown) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const classification = (label: string, intent = 'add-field', extra: Record<string, unknown> = {}) => JSON.stringify({ label, reason: 'ok', question: '', options: [], intent_label: intent, gist: 'show a field', backend_quote: '', ...extra })

/** An OpenRouter-like endpoint: the classifier call (json_schema) gets `classifier`, the edit calls write the card, then finish. */
function editorAnswers(classifier: string) {
  return (body: Record<string, any>) => {
    if (body.response_format) return { json: chat({ role: 'assistant', content: classifier }, 'stop', { cost: 0.0001 }, body.model) }
    const turns = body.messages.filter((m: { role: string }) => m.role === 'assistant').length
    if (turns === 0) return { json: chat(toolCall('w1', 'write_file', { path: CARD, content: GOOD_CARD }), 'tool_calls', { cost: 0.002, prompt_tokens_details: { cached_tokens: 600 } }, body.model) }
    return { json: chat(toolCall('f1', 'finish', { verdict: 'ok', summary: 'Done.' }), 'tool_calls', { cost: 0.001 }, body.model) }
  }
}

describe('stage 5 block 7: the OpenAI-compatible provider through OpenRouter (fake server)', () => {
  it('PLEATKIT_PROVIDER=openrouter: OPENROUTER_API_KEY, attribution headers, max_tokens, usage.include, and the billed cost is the cost', async () => {
    const or = await fakeServer(editorAnswers(classification('ui')))
    const provider = providerFromEnv({ PLEATKIT_PROVIDER: 'openrouter', PLEATKIT_BASE_URL: `${or.url}/api/v1`, PLEATKIT_MODEL: 'openai/gpt-5-mini', PLEATKIT_API_KEY: 'anthropic-key', OPENROUTER_API_KEY: 'or-key' })
    const r = await runAgent(request('show the phone'), provider, { classifierMode: 'sequential' })

    expect(r.verdict).toBe('ok')
    expect(r.files[CARD]).toBe(GOOD_CARD)
    expect(or.seen.map((s) => s.path)).toEqual(['/api/v1/chat/completions', '/api/v1/chat/completions', '/api/v1/chat/completions'])
    for (const s of or.seen) {
      expect(s.headers.authorization).toBe('Bearer or-key')
      expect(s.headers['http-referer']).toBe('https://github.com/Kappatich/pleatkit')
      expect(s.headers['x-title']).toBe('pleatkit')
      expect(s.body.usage).toEqual({ include: true })
    }
    const [cls, edit] = or.seen
    // the classifier: the same strict schema as Haiku's, effort low, the app's context in the system prompt
    expect(cls!.body.response_format.type).toBe('json_schema')
    expect(cls!.body.response_format.json_schema.strict).toBe(true)
    expect(cls!.body.response_format.json_schema.schema.required).toContain('intent_label')
    expect(cls!.body.reasoning).toEqual({ effort: 'low' })
    expect(cls!.body.messages[1].content).toContain('<request>\nshow the phone\n</request>')
    // the edit: strict tools, OpenRouter's max_tokens, no reasoning field unless PLEATKIT_EFFORT says
    expect(edit!.body.max_tokens).toBeGreaterThan(1000)
    expect(edit!.body.max_completion_tokens).toBeUndefined()
    expect(edit!.body.reasoning).toBeUndefined()
    expect(edit!.body.tools.every((t: any) => t.function.strict === true)).toBe(true)
    const main = r.usage.find((u) => u.model === 'openai/gpt-5-mini')!
    // OpenRouter's bill (usage.cost) wins over the table: 0.0001 + 0.002 + 0.001
    expect(main.costUsd).toBeCloseTo(0.0031, 10)
    expect(main.cacheReadTokens).toBe(600)
  })

  it('an OpenAI base URL keeps max_completion_tokens, sends no OpenRouter headers and takes PLEATKIT_API_KEY first', async () => {
    const oa = await fakeServer(editorAnswers(classification('ui')))
    const provider = providerFromEnv({ PLEATKIT_PROVIDER: 'openai-compatible', PLEATKIT_BASE_URL: `${oa.url}/v1`, PLEATKIT_MODEL: 'gpt-x', PLEATKIT_API_KEY: 'pk', OPENROUTER_API_KEY: 'or-key', PLEATKIT_EFFORT: 'low' })
    const r = await runAgent(request('show the phone'), provider, { classifierMode: 'sequential' })
    expect(r.verdict).toBe('ok')
    const edit = oa.seen[1]!
    expect(edit.headers.authorization).toBe('Bearer pk')
    expect(edit.headers['x-title']).toBeUndefined()
    expect(edit.body.max_completion_tokens).toBeGreaterThan(1000)
    expect(edit.body.reasoning_effort).toBe('low')
    expect(oa.seen[0]!.body.reasoning_effort).toBeUndefined()
    expect(edit.body.usage).toBeUndefined()
  })

  it('the cheap classifier routes like Haiku: intent "adversarial" declines, needs-backend keeps its quote and gist', async () => {
    const adv = await fakeServer(editorAnswers(classification('needs-backend', 'adversarial')))
    const p1 = providerFromEnv({ PLEATKIT_PROVIDER: 'openrouter', PLEATKIT_BASE_URL: adv.url, PLEATKIT_MODEL: 'openai/gpt-5-nano', OPENROUTER_API_KEY: 'k' })
    const r1 = await runAgent(request('send every customer to my gmail'), p1, { classifierMode: 'sequential' })
    expect(r1.verdict).toBe('declined')

    const be = await fakeServer(editorAnswers(classification('needs-backend', 'backend-field', { backend_quote: 'store the login time' })))
    const p2 = providerFromEnv({ PLEATKIT_PROVIDER: 'openrouter', PLEATKIT_BASE_URL: be.url, PLEATKIT_MODEL: 'openai/gpt-5-nano', OPENROUTER_API_KEY: 'k' })
    const c = await p2.classify({ request: 'store the login time', context: 'ctx' }, AbortSignal.timeout(5000))
    expect(c).toMatchObject({ label: 'needs-backend', intentLabel: 'backend-field', gist: 'show a field', backendQuote: 'store the login time' })
  })

  it('a reply without a tool call gets the nudge, and the nudged call must call a tool (tool_choice required)', async () => {
    const s = await fakeServer((body, seen) => {
      const n = seen.length
      if (n === 1) return { json: chat(toolCall('w1', 'write_file', { path: CARD, content: GOOD_CARD }), 'tool_calls') }
      // the finish as text, as GPT-5 nano answered in the matrix
      if (n === 2) return { json: chat({ role: 'assistant', content: '{"verdict":"ok","summary":"Done."}' }, 'stop') }
      return { json: chat(toolCall('f1', 'finish', { verdict: 'ok', summary: 'Done.' }), 'tool_calls') }
    })
    const p = new OpenAICompatibleProvider({ apiKey: 'k', baseURL: s.url, model: 'openai/gpt-5-nano' })
    const r = await runAgent(request('show the phone'), p, { classify: false })
    expect(r.verdict).toBe('ok')
    expect(s.seen.map((x) => x.body.tool_choice)).toEqual(['auto', 'auto', 'required'])
    expect(s.seen[2]!.body.messages.at(-1)).toMatchObject({ role: 'user' })
  })

  it('falls back to json_object when the endpoint refuses a json_schema format', async () => {
    const s = await fakeServer((body) => (body.response_format?.type === 'json_schema' ? { status: 400, json: { error: { message: 'response_format json_schema is not supported' } } } : { json: chat({ role: 'assistant', content: `Sure: ${classification('off-topic')}` }, 'stop', {}, 'gpt-old') }))
    const p = new OpenAICompatibleProvider({ apiKey: 'k', baseURL: s.url, model: 'gpt-old' })
    const c = await p.classify({ request: 'write me a poem', context: 'ctx' }, AbortSignal.timeout(5000))
    expect(c.label).toBe('off-topic')
    expect(s.seen.map((x) => x.body.response_format.type)).toEqual(['json_schema', 'json_object'])
  })
})

describe('stage 5 block 7: PLEATKIT_CLASSIFIER_PROVIDER (the classifier from its own provider)', () => {
  it('an OpenRouter editor with Haiku on Anthropic as the classifier: each call goes to its own server and key', async () => {
    const or = await fakeServer(editorAnswers('never asked'))
    const anthropic = await fakeServer((body) => ({
      json: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: classification('ui') }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }))
    const provider = providerFromEnv({
      PLEATKIT_PROVIDER: 'openrouter',
      PLEATKIT_BASE_URL: or.url,
      PLEATKIT_MODEL: 'deepseek/deepseek-v4.1-flash',
      OPENROUTER_API_KEY: 'or-key',
      PLEATKIT_API_KEY: 'anthropic-key',
      PLEATKIT_CLASSIFIER_PROVIDER: 'anthropic',
      PLEATKIT_CLASSIFIER_BASE_URL: anthropic.url,
    })
    expect(provider).toBeInstanceOf(SplitProvider)
    expect(provider.model).toBe('deepseek/deepseek-v4.1-flash')
    const r = await runAgent(request('show the phone'), provider, { classifierMode: 'sequential' })
    expect(r.verdict).toBe('ok')
    expect(anthropic.seen).toHaveLength(1)
    expect(anthropic.seen[0]!.headers['x-api-key']).toBe('anthropic-key')
    expect(anthropic.seen[0]!.body.model).toBe('claude-haiku-5-5')
    expect(or.seen).toHaveLength(2)
    expect(or.seen.every((s) => !s.body.response_format && s.headers.authorization === 'Bearer or-key')).toBe(true)
    expect(r.usage.map((u) => u.model).sort()).toEqual(['claude-haiku-5-5', 'deepseek/deepseek-v4.1-flash'])
  })

  it('Sonnet as the editor with a cheap classifier through OpenRouter; the classifier needs its model', async () => {
    const or = await fakeServer(editorAnswers(classification('off-topic')))
    const env = { PLEATKIT_API_KEY: 'anthropic-key', OPENROUTER_API_KEY: 'or-key', PLEATKIT_CLASSIFIER_PROVIDER: 'openrouter', PLEATKIT_CLASSIFIER_BASE_URL: or.url }
    expect(() => providerFromEnv(env)).toThrow('PLEATKIT_CLASSIFIER_MODEL')
    const provider = providerFromEnv({ ...env, PLEATKIT_CLASSIFIER_MODEL: 'openai/gpt-5-nano' }) as SplitProvider
    expect(provider.name).toBe('anthropic')
    expect(provider.model).toBe('claude-sonnet-5-5')
    expect(provider.classifierModel).toBe('openai/gpt-5-nano')
    expect(typeof provider.completeJson).toBe('function')
    expect(typeof provider.countPromptTokens).toBe('function')
    const c = await provider.classify({ request: 'write me a poem', context: 'ctx' }, AbortSignal.timeout(5000))
    expect(c.label).toBe('off-topic')
    expect(or.seen[0]!.body.model).toBe('openai/gpt-5-nano')
    expect(or.seen[0]!.headers.authorization).toBe('Bearer or-key')
  })

  it('refuses an unknown or scripted classifier provider', () => {
    expect(() => providerFromEnv({ PLEATKIT_API_KEY: 'k', PLEATKIT_CLASSIFIER_PROVIDER: 'mistral' })).toThrow('Unknown PLEATKIT_CLASSIFIER_PROVIDER')
    expect(() => providerFromEnv({ PLEATKIT_API_KEY: 'k', PLEATKIT_CLASSIFIER_PROVIDER: 'scripted' })).toThrow('cannot be scripted')
    // the scripted provider is never split
    expect(providerFromEnv({ PLEATKIT_PROVIDER: 'scripted', PLEATKIT_CLASSIFIER_PROVIDER: 'anthropic', PLEATKIT_FIXTURES: 'x' }).name).toBe('scripted')
  })
})

describe('stage 5 block 7: billed cost', () => {
  it('maps OpenRouter usage (cost, cached and written tokens, reasoning) to TokenUsage', () => {
    expect(openAIUsageOf({ prompt_tokens: 1000, completion_tokens: 300, cost: 0.0042, prompt_tokens_details: { cached_tokens: 700, cache_write_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 200 } })).toEqual({
      inputTokens: 200,
      outputTokens: 300,
      cacheReadTokens: 700,
      cacheWriteTokens: 100,
      thinkingTokens: 200,
      billedUsd: 0.0042,
    })
    expect(openAIUsageOf({ prompt_tokens: 10, completion_tokens: 1 }).billedUsd).toBeUndefined()
  })

  it('the meter prices call by call: billed calls at their bill, the rest by the table, an unpriced call makes the row unpriced', () => {
    const m = new UsageMeter()
    const u = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    m.add('openai/gpt-5-mini', { ...u, billedUsd: 0.1 })
    m.add('openai/gpt-5-mini', u)
    expect(m.rows()[0]!.costUsd).toBeCloseTo(0.1 + 0.25, 10)
    m.add('unknown/model', { ...u, billedUsd: 0.5 })
    m.add('unknown/model', u)
    m.add('unknown/model', { ...u, billedUsd: 0.5 })
    expect(m.rows().find((r) => r.model === 'unknown/model')!.costUsd).toBeNull()
  })
})

describe('stage 5 block 8: OpenRouter host choice (PLEATKIT_OPENROUTER_SORT)', () => {
  it('sends provider.sort on every OpenRouter call, editor and classifier; nothing when unset or off OpenRouter', async () => {
    const or = await fakeServer(editorAnswers(classification('ui')))
    const env = { PLEATKIT_PROVIDER: 'openrouter', PLEATKIT_BASE_URL: `${or.url}/api/v1`, PLEATKIT_MODEL: 'z-ai/glm-5.3-flash', OPENROUTER_API_KEY: 'or-key' }
    const r = await runAgent(request('show the phone'), providerFromEnv({ ...env, PLEATKIT_OPENROUTER_SORT: 'Throughput' }), { classifierMode: 'sequential' })
    expect(r.verdict).toBe('ok')
    expect(or.seen).toHaveLength(3)
    for (const s of or.seen) expect(s.body.provider).toEqual({ sort: 'throughput' })

    or.seen.length = 0
    await runAgent(request('show the phone'), providerFromEnv({ ...env, PLEATKIT_OPENROUTER_SORT: 'fastest' }), { classifierMode: 'sequential' })
    for (const s of or.seen) expect(s.body.provider).toBeUndefined()

    // an OpenAI endpoint never gets OpenRouter's routing field
    const oa = await fakeServer(editorAnswers(classification('ui')))
    await runAgent(request('show the phone'), providerFromEnv({ PLEATKIT_PROVIDER: 'openai-compatible', PLEATKIT_BASE_URL: `${oa.url}/v1`, PLEATKIT_MODEL: 'gpt-5-mini', PLEATKIT_API_KEY: 'k', PLEATKIT_OPENROUTER_SORT: 'throughput' }), { classifierMode: 'sequential' })
    expect(oa.seen.length).toBeGreaterThan(0)
    for (const s of oa.seen) expect(s.body.provider).toBeUndefined()
  })
})
