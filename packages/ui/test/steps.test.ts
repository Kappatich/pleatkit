import { describe, expect, it } from 'vitest'
import type { AgentProgress } from '@morphkit/runtime'
import { translator, UI_MESSAGES } from '../src/i18n.js'
import { addStep, MAX_VISIBLE_STEPS, visibleSteps, type Step } from '../src/steps.js'

const status = (text: string): AgentProgress => ({ type: 'status', text })
const thinking: AgentProgress = { type: 'model', turn: 2, text: 'Thinking', transient: true }
const tool = (text: string): AgentProgress => ({ type: 'tool', turn: 1, tool: 'read_file', text })
const check = (ok: boolean): AgentProgress => ({ type: 'check', ok, errorCount: ok ? 0 : 1, text: ok ? 'Everything works' : 'Found a problem, fixing it' })

const run = (events: AgentProgress[]): Step[] => events.reduce<Step[]>((s, e) => addStep(s, e), [])

describe('progress steps (DECISIONS 19)', () => {
  it('"Thinking" never repeats and is replaced by the next real step', () => {
    const steps = run([
      status('Understanding the request'),
      { type: 'model', turn: 1, text: 'Planning the change' },
      tool('Looking at the customer card'),
      thinking,
      thinking,
      tool('Changing the customer card'),
      thinking,
    ])
    expect(steps.map((s) => s.text)).toEqual(['Understanding the request', 'Planning the change', 'Looking at the customer card', 'Changing the customer card', 'Thinking'])
    expect(steps.filter((s) => s.text === 'Thinking')).toHaveLength(1)
    expect(steps.at(-1)?.transient).toBe(true)
  })

  it('collapses identical lines in a row into one with a count', () => {
    const steps = run([tool('Looking at the customer card'), tool('Looking at the customer card'), tool('Looking at the customer card'), check(false), check(false)])
    expect(steps).toEqual([
      { text: 'Looking at the customer card', count: 3 },
      { text: 'Found a problem, fixing it', tone: 'bad', count: 2 },
    ])
  })

  it('keeps a failed and a passed check apart', () => {
    expect(run([check(false), check(true)]).map((s) => s.tone)).toEqual(['bad', 'good'])
  })

  it(`shows at most ${MAX_VISIBLE_STEPS} lines, the latest ones, the rest behind the toggle`, () => {
    const steps = Array.from({ length: 9 }, (_, i) => ({ text: `step ${i + 1}` }))
    const collapsed = visibleSteps(steps, false)
    expect(collapsed.hidden).toBe(3)
    expect(collapsed.shown.map((s) => s.text)).toEqual(['step 4', 'step 5', 'step 6', 'step 7', 'step 8', 'step 9'])
    expect(visibleSteps(steps, true)).toEqual({ shown: steps, hidden: 0 })
    expect(visibleSteps(steps.slice(0, 6), false).hidden).toBe(0)
  })
})

describe('chat and admin dictionary (DECISIONS 20)', () => {
  it('ru has every en key, and no empty strings', () => {
    expect(Object.keys(UI_MESSAGES.ru).sort()).toEqual(Object.keys(UI_MESSAGES.en).sort())
    for (const v of [...Object.values(UI_MESSAGES.en), ...Object.values(UI_MESSAGES.ru)]) expect(v.trim()).not.toBe('')
  })

  it('placeholders survive translation', () => {
    for (const key of Object.keys(UI_MESSAGES.en) as (keyof typeof UI_MESSAGES.en)[]) {
      const names = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort()
      expect(names(UI_MESSAGES.ru[key]), key).toEqual(names(UI_MESSAGES.en[key]))
    }
  })

  it('defaults to English and fills parameters', () => {
    expect(translator()('admin.rollback', { user: 'alice' })).toBe('Roll back for alice')
    expect(translator('ru')('admin.rollback', { user: 'alice' })).toBe('Откатить у alice')
    expect(translator('ru')('chat.send')).toBe('Отправить')
  })
})
