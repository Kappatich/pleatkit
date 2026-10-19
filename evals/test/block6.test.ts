import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { digestsOf } from '../src/runner.js'
import { loadManifest, loadTasks, prepareTask, SUITES } from '../src/tasks.js'
import { classifiedRight, probeVerdict } from '../src/probe-labels.js'

const env = { ...process.env }
afterEach(() => {
  for (const k of ['PLEATKIT_EVAL_POINT', 'PLEATKIT_EVAL_PANEL_SHOTS', 'PLEATKIT_EVAL_PREFIX_NONCE']) {
    if (env[k] === undefined) delete process.env[k]
    else process.env[k] = env[k]
  }
})

const demo = fs.existsSync(path.join(SUITES.demo, '..', '..', 'apps', 'demo-crm', 'dist', 'pleatkit.manifest.json'))

describe.skipIf(!demo)('stage 5 block 6: pointing and the panel screenshot in the evals', () => {
  const task = loadTasks(SUITES.demo, ['crm-04-deals-total-row'])[0]!
  const manifest = loadManifest()

  it('--point points at the panel the reference changes, only when the task points at none', () => {
    expect(prepareTask(task, manifest).request.target).toBeUndefined()
    process.env.PLEATKIT_EVAL_POINT = '1'
    expect(prepareTask(task, manifest).request.target).toBe('deals-table')
  })

  it('--panel-shots attaches <dir>/<task>.before.png as the target image of a pointed request', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-shots-'))
    fs.writeFileSync(path.join(dir, `${task.id}.before.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    process.env.PLEATKIT_EVAL_PANEL_SHOTS = dir
    expect(prepareTask(task, manifest).request.targetImage).toBeUndefined()
    process.env.PLEATKIT_EVAL_POINT = '1'
    expect(prepareTask(task, manifest).request.targetImage).toMatchObject({ mediaType: 'image/png', data: 'iVBORw==' })
  })

  it('a cache A/B nonce changes only the cached design-system notes', () => {
    const plain = digestsOf(manifest)
    process.env.PLEATKIT_EVAL_PREFIX_NONCE = 'arm-a'
    const a = digestsOf(manifest)
    expect(a.designSystem?.docs).toContain('(eval run arm-a)')
    expect({ ...a, designSystem: plain.designSystem }).toEqual(plain)
  })
})

describe('stage 5 block 6: the new probe sets', () => {
  const read = (f: string) => (JSON.parse(fs.readFileSync(path.join(SUITES.demo, '..', 'probes', f), 'utf8')) as { probes: { id: string; app: string; request: string; expected: string }[] }).probes
  it('has 32 Russian and 20 new awkward probes with labels eval:classify knows', () => {
    const ru = read('russian.json')
    const aw = read('awkward-2.json')
    expect(ru).toHaveLength(32)
    expect(aw).toHaveLength(20)
    const known = ['ui', 'mixed', 'needs-backend', 'clarify', 'declined', 'off-topic', 'restore', 'not-editable']
    for (const p of [...ru, ...aw]) expect(known).toContain(p.expected)
    expect(new Set([...ru, ...aw].map((p) => p.id)).size).toBe(52)
    // a mixed probe is right when the classifier sends it to the main model
    expect(classifiedRight(probeVerdict('mixed'), 'ui/fields-add')).toBe(true)
  })
})
