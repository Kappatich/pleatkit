import { describe, expect, it } from 'vitest'
import { classifiedRight, probeChanges, probeVerdict } from '../src/probe-labels.js'

const score = (expected: string, now: string) => classifiedRight(probeVerdict(expected), now)

describe('eval:classify scores the labels of the /admin Labels screen (DECISIONS 81)', () => {
  it('keeps the existing probe labels', () => {
    expect(score('ui', 'ui/')).toBe(true)
    expect(score('ui', 'needs-backend/')).toBe(false)
    expect(score('needs-backend', 'needs-backend/out-of-zone')).toBe(true)
    expect(score('needs-backend', 'ui/')).toBe(false)
    expect(probeChanges('ui')).toBe(true)
    expect(probeChanges('needs-backend')).toBe(false)
  })

  it('clarify is the classifier saying unclear, declined its adversarial intent, mixed a ui label', () => {
    expect(score('clarify', 'unclear/')).toBe(true)
    expect(score('clarify', 'ui/')).toBe(false)
    expect(score('declined', 'off-topic/adversarial')).toBe(true)
    expect(score('declined', 'ui/adversarial')).toBe(true)
    expect(score('declined', 'off-topic/off-topic')).toBe(false)
    expect(score('mixed', 'ui/')).toBe(true)
    expect(score('mixed', 'needs-backend/')).toBe(false)
    expect(probeVerdict('mixed')).toBe('partial')
    expect(probeChanges('mixed')).toBe(true)
    expect(score('off-topic', 'off-topic/off-topic')).toBe(true)
  })

  it('any other label is compared by name (e.g. restore)', () => {
    expect(score('restore', 'restore/undo-earlier-edit')).toBe(true)
    expect(score('restore', 'ui/')).toBe(false)
  })
})
