import { describe, expect, it } from 'vitest'
import { runAgent } from '../src/loop.js'
import { CLASSIFIER_INSTRUCTIONS, instructions, PROMPT_VERSION } from '../src/prompt.js'
import { CLASSIFIER_ONLY_VERDICTS } from '../src/classifier-mode.js'
import { ScriptedProvider } from '../src/providers/scripted.js'
import type { ScriptFixture } from '../src/providers/scripted.js'
import { request } from './helpers.js'

const fx = (overrides: Partial<ScriptFixture>): ScriptedProvider =>
  new ScriptedProvider([{ name: 'f', match: ['.*'], turns: [], ...overrides, patterns: [/.*/s], dir: '.' }] as never)

describe('stage 5 block 5: the restore label (DECISIONS 82.2)', () => {
  it('"put it back like it was" is answered with verdict restore, without the model and without changes', async () => {
    const provider = fx({ classify: { label: 'restore', reason: 'You want an earlier version back.', intentLabel: 'undo-earlier-edit', gist: 'go back to an earlier version' } })
    const r = await runAgent(request('put everything back like it was'), provider)
    expect(r.verdict).toBe('restore')
    expect(r.modelCalls).toBe(0)
    expect(Object.keys(r.files)).toHaveLength(0)
    expect(r.deleted).toHaveLength(0)
    expect(r.summary).toMatch(/history/i)
    expect(r.intentLabel).toBe('undo-earlier-edit')
  })

  it('the restore summary follows the locale and the sequential mode answers the same', async () => {
    const provider = fx({ classify: { label: 'restore', reason: '' } })
    const r = await runAgent(request('верни как было', { locale: 'ru' }), provider, { classifierMode: 'sequential' })
    expect(r.verdict).toBe('restore')
    expect(r.summary).toMatch(/истори/)
  })

  it('a pointed panel skips the classifier, so the main model answers (no restore without the classifier)', async () => {
    const provider = fx({ classify: { label: 'restore', reason: '' }, turns: [{ calls: [{ tool: 'finish', input: { verdict: 'clarify', summary: 'Which version?', question: 'Which version?', options: ['Yesterday', 'The original'] } }] }] })
    const r = await runAgent(request('put it back like it was', { target: 'customer-card' }), provider)
    expect(r.verdict).toBe('clarify')
  })

  it('restore counts as an answer of the classifier alone for the automatic mode', () => {
    expect(CLASSIFIER_ONLY_VERDICTS).toContain('restore')
  })
})

describe('stage 5 block 5: prompt 5i', () => {
  it('bumps the prompt version', () => {
    expect(PROMPT_VERSION).toBe('2026-10-19.5i')
  })

  it('the classifier has the restore label, the scheduled-job example and the integration rule', () => {
    expect(CLASSIFIER_INSTRUCTIONS).toContain('- "restore":')
    expect(CLASSIFIER_INSTRUCTIONS).toMatch(/every night archive the old ones/)
    expect(CLASSIFIER_INSTRUCTIONS).toMatch(/push the monthly totals to our ERP/)
    expect(CLASSIFIER_INSTRUCTIONS).toMatch(/integration, intent_label "backend-integration", not adversarial/)
    // the 76.6 probes themselves are not in the prompt (the example must generalise, not memorise)
    expect(CLASSIFIER_INSTRUCTIONS).not.toMatch(/reassign overdue tasks|accounting system/)
  })

  it('the editor knows the app’s allowedHosts (DECISIONS 82.5), and says nothing about hosts without them', () => {
    const base = request('show the avatar')
    const without = instructions(base)
    expect(without).not.toMatch(/allows images and links to these hosts/)
    const withHosts = instructions(request('show the avatar', { context: { ...base.context, allowedHosts: ['images.example-cdn.com', 'cdn.example.org'] } }))
    expect(withHosts).toContain('allows images and links to these hosts, over https only: images.example-cdn.com, cdn.example.org')
  })
})

describe('stage 5 block 5: the warm type check (brainstorm 17 §4)', () => {
  it('a warmed checker with the app root keeps finding new errors and passing good edits, over and over', async () => {
    const path = await import('node:path')
    const { createTypechecker, warmTypecheck } = await import('../src/typecheck.js')
    const root = path.resolve(import.meta.dirname, '../../../apps/demo-crm')
    const tc = createTypechecker({ root })
    const ui = `import type { HTMLAttributes } from 'react'
export function Card(props: HTMLAttributes<HTMLDivElement>) { return <div {...props} /> }
`
    const card = (attr: string) => `import { Card } from '@/readonly/ui'
export default function CustomerCard({ customer }: { customer: { id: string; name: string } }) {
  return <div data-testid="customer-card">{[customer].map((c) => <Card key={c.id} ${attr}>{c.name}</Card>)}</div>
}
`
    const { CARD } = await import('./helpers.js')
    const input = { ...request('x'), readonly: { 'src/readonly/ui.tsx': ui } }
    const ms = await warmTypecheck(tc, { ...input, files: { ...input.files, [CARD]: card('') } })
    expect(ms).toBeGreaterThan(0)
    for (let i = 0; i < 3; i++) {
      expect(await tc({ ...input.files, [CARD]: card(`data-i="${i}"`) }, input)).toEqual([])
      const bad = await tc({ ...input.files, [CARD]: card(`tone="loud${i}"`) }, input)
      expect(bad.map((e) => e.text).join(' ')).toMatch(/tone/)
    }
  })

  it('warming never throws, even when the checker does', async () => {
    const { warmTypecheck } = await import('../src/typecheck.js')
    const failing = async () => {
      throw new Error('boom')
    }
    await expect(warmTypecheck(failing, { ...request('x') })).resolves.toBeGreaterThanOrEqual(0)
  })
})

describe('stage 5 block 5: an app without Tailwind is told so', () => {
  it('palette mode gets its own stack sentence; Tailwind apps keep theirs', () => {
    const base = request('x')
    const palette = instructions(request('x', { context: { ...base.context, css: { mode: 'palette', hash: 'h' } } }))
    expect(palette).toMatch(/This app has no Tailwind/)
    expect(palette).not.toMatch(/Tailwind CSS 4 utility classes/)
    const tw = instructions(request('x', { context: { ...base.context, css: { mode: 'tailwind', input: '', hash: 'h' } } }))
    expect(tw).toMatch(/Tailwind CSS 4 utility classes/)
    expect(instructions(base)).toMatch(/Tailwind CSS 4 utility classes/)
  })
})

describe('stage 5 block 5: a bundle store-server lost is stored again (found by a blind install)', () => {
  it('after store-server starts on a new database, the next compile of the same key puts the bundle back', async () => {
    const { createStoreApp, openStore } = await import('../../store-server/src/app.js')
    const { BundleService } = await import('../src/bundle.js')
    const { StoreClient } = await import('../src/store-client.js')
    let current = createStoreApp(openStore().db)
    const fetchVia = ((input: string | URL | Request, init?: RequestInit) => current.request(String(input), init)) as typeof fetch
    const svc = new BundleService(null, new StoreClient('http://store.test', null, fetchVia), 500, null)
    const req = request('x')
    const input = { appId: 'crm', files: req.files, readonly: req.readonly, context: req.context, components: req.components }
    const first = await svc.compile(input)
    expect(first.ok).toBe(true)
    const has = async () => (await current.request(`/v1/b/crm/${first.key}.json`)).ok
    expect(await has()).toBe(true)
    current = createStoreApp(openStore().db) // the developer deleted .pleatkit/store.db and restarted store-server
    expect(await has()).toBe(false)
    const again = await svc.compile(input)
    expect(again.key).toBe(first.key)
    expect(await has()).toBe(true)
  })
})
