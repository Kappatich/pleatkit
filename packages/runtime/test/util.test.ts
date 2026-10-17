import { describe, expect, it } from 'vitest'
import { hashFiles, ulid } from '../src/util.js'

describe('hashFiles', () => {
  it('does not depend on key order', async () => {
    const a = await hashFiles({ 'a.tsx': '1', 'b.tsx': '2' })
    const b = await hashFiles({ 'b.tsx': '2', 'a.tsx': '1' })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when content or path changes', async () => {
    const base = await hashFiles({ 'a.tsx': '1' })
    expect(await hashFiles({ 'a.tsx': '2' })).not.toBe(base)
    expect(await hashFiles({ 'b.tsx': '1' })).not.toBe(base)
  })
})

describe('ulid', () => {
  it('is 26 chars and monotonic within one millisecond', () => {
    const ids = Array.from({ length: 50 }, () => ulid(1_700_000_000_000))
    expect(ids[0]).toHaveLength(26)
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
