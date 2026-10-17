import { describe, expect, it } from 'vitest'
import { applyQuotaOps, daily } from '../src/quota.js'
import {
  isAppKey,
  mintUserToken,
  newAppKey,
  publicKeyFromAppKey,
  signBundle,
  signingKeyFromAppKey,
  sriDigest,
  toBase64Url,
  verifyBundleSignature,
  verifyUserToken,
  type BundleSignaturePayload,
} from '../src/security.js'
import { applyQuotaOps as fromIndex } from '../src/index.js'

const SECRET = 'x'.repeat(40)
const APP_KEY = 'mk_live_abcdefghijklmnopqrstuvwxyz012345'

describe('user tokens (V1 A1)', () => {
  it('mints and verifies an HS256 token with the claims', async () => {
    const token = await mintUserToken({ secret: SECRET, userId: 'alice', appId: 'crm', orgId: 'acme', role: 'admin' })
    const claims = await verifyUserToken(token, SECRET)
    expect(claims).toMatchObject({ sub: 'alice', app: 'crm', org: 'acme', role: 'admin' })
    expect(claims.exp - claims.iat).toBe(900)
  })

  it('refuses a wrong secret, a tampered body, alg none, expired and long-lived tokens', async () => {
    const token = await mintUserToken({ secret: SECRET, userId: 'alice', appId: 'crm' })
    await expect(verifyUserToken(token, 'y'.repeat(40))).rejects.toThrow('bad token signature')
    const [h, , s] = token.split('.')
    const forged = toBase64Url(new TextEncoder().encode(JSON.stringify({ sub: 'bob', app: 'crm', iat: 1, exp: 9e9 })))
    await expect(verifyUserToken(`${h}.${forged}.${s}`, SECRET)).rejects.toThrow()
    const none = toBase64Url(new TextEncoder().encode(JSON.stringify({ alg: 'none' })))
    await expect(verifyUserToken(`${none}.${token.split('.')[1]}.`, SECRET)).rejects.toThrow('unsupported token algorithm')
    const old = await mintUserToken({ secret: SECRET, userId: 'alice', appId: 'crm', now: Date.now() / 1000 - 3600 })
    await expect(verifyUserToken(old, SECRET)).rejects.toThrow('expired')
    await expect(mintUserToken({ secret: SECRET, userId: 'alice', appId: 'crm', ttlSeconds: 3600 })).rejects.toThrow('ttlSeconds')
    await expect(mintUserToken({ secret: 'short', userId: 'alice', appId: 'crm' })).rejects.toThrow('32 characters')
  })
})

describe('bundle signatures (V1 A3)', () => {
  const payload = async (): Promise<BundleSignaturePayload> => ({
    v: 1,
    app: 'crm',
    key: 'ab'.repeat(20),
    filesHash: 'f'.repeat(64),
    js: await sriDigest('export const modules = {}'),
    css: await sriDigest(''),
    externals: ['react'],
    compiler: 'test',
    createdAt: '2026-10-18T00:00:00.000Z',
  })

  it('derives one ed25519 key per app key, deterministically', async () => {
    expect(isAppKey(APP_KEY)).toBe(true)
    expect(isAppKey('sk-ant-123')).toBe(false)
    expect(isAppKey(newAppKey())).toBe(true)
    const a = await signingKeyFromAppKey(APP_KEY)
    expect(a.publicKey).toBe(await publicKeyFromAppKey(APP_KEY))
    expect(a.publicKey).not.toBe(await publicKeyFromAppKey(newAppKey()))
    expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('verifies a signature and refuses a changed payload, another key or a missing signature', async () => {
    const key = await signingKeyFromAppKey(APP_KEY)
    const signed = await signBundle(await payload(), key)
    await verifyBundleSignature(signed, key.publicKey)
    await expect(verifyBundleSignature({ ...signed, payload: { ...signed.payload, app: 'other' } }, key.publicKey)).rejects.toThrow('bad bundle signature')
    await expect(verifyBundleSignature({ ...signed, payload: { ...signed.payload, js: await sriDigest('alert(1)') } }, key.publicKey)).rejects.toThrow('bad bundle signature')
    await expect(verifyBundleSignature(signed, await publicKeyFromAppKey(newAppKey()))).rejects.toThrow('bad bundle signature')
    await expect(verifyBundleSignature({ payload: signed.payload }, key.publicKey)).rejects.toThrow('not signed')
  })
})

describe('quota token buckets (V1 A4)', () => {
  it('takes, refuses atomically, refills over time and lets a cost go negative', () => {
    expect(fromIndex).toBe(applyQuotaOps)
    const state = new Map<string, { tokens: number; updatedMs: number }>()
    const run = (ops: Parameters<typeof applyQuotaOps>[1], now: number) => {
      const r = applyQuotaOps((k) => state.get(k), ops, now)
      for (const [k, v] of Object.entries(r.writes)) state.set(k, v)
      return r.outcome
    }
    const edits = daily('user:alice:edits', 2)
    const usd = daily('user:alice:usd', 1)
    expect(run([{ ...edits, op: 'take' }, { ...usd, op: 'peek' }], 0).ok).toBe(true)
    expect(run([{ ...usd, op: 'debit', amount: 1.5 }], 0).tokens['user:alice:usd']).toBeCloseTo(-0.5)
    // dollars are over: the edit is refused and the edit bucket is untouched
    const refused = run([{ ...edits, op: 'take' }, { ...usd, op: 'peek' }], 0)
    expect(refused).toMatchObject({ ok: false, refused: 'user:alice:usd' })
    expect(refused.retryAfterMs).toBeGreaterThan(0)
    expect(state.get('user:alice:edits')!.tokens).toBe(1)
    // half a day later the dollar bucket has refilled by 0.5
    expect(run([{ ...edits, op: 'take' }, { ...usd, op: 'peek' }], 43_200_000 + 1000).ok).toBe(true)
  })
})
