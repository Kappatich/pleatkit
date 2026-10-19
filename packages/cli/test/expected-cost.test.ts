import { describe, expect, it } from 'vitest'
import { estimateContextTokens, measureContextBudget } from '../src/doctor.js'

const manifest = {
  version: 1 as const,
  dynamicRoots: ['src/dynamic/'],
  dynamic: [{ path: 'src/dynamic/orders.tsx', source: 'export default function Orders() { return <div /> }\n' }],
  readonly: [{ path: 'src/readonly/api.ts', source: 'x'.repeat(22_000) }],
  coreTypes: [],
  externals: ['react', 'react/jsx-runtime'],
  externalPatterns: ['react', 'react/jsx-runtime'],
  alias: { '@': 'src' },
}

const line = (details: string[]) => details.find((d) => d.startsWith('Expected cost per edit on this app'))

describe('DECISIONS 75 Р2: doctor prints the expected cost of an edit', () => {
  it('from the counted prompt, with the model and the classifier', async () => {
    const agent = await import('@pleatkit/agent')
    const counted = await measureContextBudget(manifest, { PLEATKIT_API_KEY: 'k' }, { ...agent, countPromptTokens: async () => ({ prefixTokens: 13_018, tailTokens: 10_343, model: 'claude-sonnet-5-5', promptVersion: 'x' }) })
    const e = agent.expectedEditCost({ prefixTokens: 13_018, tailTokens: 10_343 }, 'claude-sonnet-5-5', 'claude-haiku-5-5')
    expect(line(counted.details)).toBe(`Expected cost per edit on this app: ${agent.formatUsd(e.expectedUsd!)} (cold: ${agent.formatUsd(e.coldUsd!)}) with claude-sonnet-5-5 and the claude-haiku-5-5 classifier`)
    // block 6: a cold edit writes the prefix for an hour (2x input), so it costs more than with the 5-minute TTL
    expect(line(counted.details)).toMatch(/\$0\.03\d\d \(cold: \$0\.0[78]\d\d\)/)
    expect(counted.details.join('\n')).toMatch(/from the counted prompt size: prefix read from the cache, tail written to it, 550 output tokens, a second call in 25 % of edits/)
  })

  it('from the estimate without a key, or when the counter fails; another model and classifier from the environment', async () => {
    const agent = await import('@pleatkit/agent')
    const est = estimateContextTokens(manifest)
    expect(est.cached).toBe(3_500 + 10_000)
    const e = agent.expectedEditCost({ prefixTokens: est.cached, tailTokens: est.tail }, 'claude-sonnet-5-5', 'claude-haiku-5-5')
    const estimated = await measureContextBudget(manifest, {}, agent)
    expect(line(estimated.details)).toContain(`${agent.formatUsd(e.expectedUsd!)} (cold: ${agent.formatUsd(e.coldUsd!)})`)
    expect(estimated.details.join('\n')).toMatch(/from the estimated prompt size/)
    const failing = await measureContextBudget(manifest, { PLEATKIT_API_KEY: 'k' }, { ...agent, countPromptTokens: async () => Promise.reject(new Error('401 invalid x-api-key')) })
    expect(failing.details.join('\n')).toMatch(/token counter failed[\s\S]*from the estimated prompt size/)
    const haiku = await measureContextBudget(manifest, { PLEATKIT_MODEL: 'claude-haiku-5-5' }, agent)
    expect(line(haiku.details)).toMatch(/with claude-haiku-5-5 and the claude-haiku-5-5 classifier/)
    const openai = await measureContextBudget(manifest, { PLEATKIT_PROVIDER: 'openrouter', PLEATKIT_MODEL: 'some/model' }, agent)
    expect(line(openai.details)).toBe('Expected cost per edit on this app: unknown (no price for some/model)')
  })

  it('nothing when the agent package is missing or too old', async () => {
    const agent = await import('@pleatkit/agent')
    expect(line((await measureContextBudget(manifest, {}, null)).details)).toBeUndefined()
    const old = { Workspace: agent.Workspace, trustedInput: agent.trustedInput, countPromptTokens: agent.countPromptTokens, sampleRequest: agent.sampleRequest, formatErrors: agent.formatErrors }
    expect(line((await measureContextBudget(manifest, {}, old)).details)).toBeUndefined()
  })
})
