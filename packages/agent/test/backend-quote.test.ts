import { describe, expect, it } from 'vitest'
import { backendQuoteOf } from '../src/tools.js'
import { runAgent } from '../src/loop.js'
import { ScriptedProvider } from '../src/providers/scripted.js'
import type { ScriptFixture } from '../src/providers/scripted.js'
import { CARD, GOOD_CARD, request } from './helpers.js'

describe('block 4: backendQuote is the verbatim part of the request that needs the server', () => {
  it('keeps a quote that is a substring, normalising whitespace', () => {
    const req = 'Show the phone and keep a history of its changes on the server'
    expect(backendQuoteOf('keep a history of its changes on the server', req)).toBe('keep a history of its changes on the server')
    expect(backendQuoteOf('  keep a history   of its changes on the server  ', req)).toBe('keep a history of its changes on the server')
  })
  it('drops trailing punctuation to match', () => {
    expect(backendQuoteOf('email the assignee.', 'please email the assignee')).toBe('email the assignee')
  })
  it('falls back to the whole request when the quote is not a substring (no invented text)', () => {
    const req = 'Show the phone and keep a history'
    expect(backendQuoteOf('store every phone change with time and author', req)).toBe(req)
  })
  it('returns undefined for an empty quote', () => {
    expect(backendQuoteOf('   ', 'anything')).toBeUndefined()
  })

  const fx = (overrides: Partial<ScriptFixture>): ScriptedProvider =>
    // ScriptedProvider takes loaded fixtures (patterns compiled); for the test, match everything
    new ScriptedProvider([{ name: 'f', match: ['.*'], turns: [], ...overrides, patterns: [/.*/s], dir: '.' }] as never)

  it('a partial answer from the main model carries backendQuote', async () => {
    const provider = fx({
      classify: { label: 'ui', reason: '', intentLabel: 'show-existing-data', gist: 'show the phone' },
      turns: [
        { calls: [{ tool: 'write_file', input: { path: CARD, content: GOOD_CARD } }] },
        { calls: [{ tool: 'finish', input: { verdict: 'partial', summary: 'The phone is shown; the history was passed on.', backend_note: 'store every phone change', backend_quote: 'keep a history of its changes on the server' } }] },
      ],
    })
    const r = await runAgent(request('Show the phone and keep a history of its changes on the server'), provider, { classifierMode: 'sequential' })
    expect(r.verdict).toBe('partial')
    expect(r.backendQuote).toBe('keep a history of its changes on the server')
    expect(r.backendNote).toContain('store every phone change')
  })

  it('a classifier-only needs-backend answer takes the quote from the classifier field', async () => {
    const provider = fx({
      classify: { label: 'needs-backend', reason: 'That needs the server.', intentLabel: 'backend-integration', gist: 'email on overdue', backendQuote: 'email the assignee when a task is overdue' },
    })
    const r = await runAgent(request('In the tasks table, email the assignee when a task is overdue'), provider)
    expect(r.verdict).toBe('needs-backend')
    expect(r.backendQuote).toBe('email the assignee when a task is overdue')
  })

  it('an ok answer carries no backendQuote', async () => {
    const provider = fx({
      classify: { label: 'ui', reason: '', intentLabel: 'show-existing-data', gist: 'show the phone' },
      turns: [
        { calls: [{ tool: 'write_file', input: { path: CARD, content: GOOD_CARD } }] },
        { calls: [{ tool: 'finish', input: { verdict: 'ok', summary: 'Done.', backend_quote: 'ignored' } }] },
      ],
    })
    const r = await runAgent(request('show the phone'), provider, { classifierMode: 'sequential' })
    expect(r.verdict).toBe('ok')
    expect(r.backendQuote).toBeUndefined()
  })
})
