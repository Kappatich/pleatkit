// Security primitives shared by the browser runtime, the agent server and store-server (V1 A1, A3).
// WebCrypto only (browsers and Node 22+), no dependencies:
// - user tokens: HS256 JWTs minted by the customer's backend with the app's user-JWT secret, 15 minutes max;
// - bundle signatures: ed25519, the private key derived from the app key (`mk_live_…`) with HKDF, so the
//   app key is the only secret; the public key goes into the app's build and the runtime verifies with it.

import { digest } from './sha.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle
  if (!s) throw new Error('pleatkit: WebCrypto (crypto.subtle) is not available here; tokens and bundle signatures need a secure context (https:// or localhost)')
  return s
}

// --- base64 / base64url ---

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64.length / 4) * 4, '='))
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export const toBase64Url = (bytes: Uint8Array): string => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

/** `sha384-<base64>` of a string: the Subresource Integrity form, usable on `<script integrity>`. */
export async function sriDigest(text: string): Promise<string> {
  return `sha384-${toBase64(await digest('SHA-384', enc.encode(text)))}`
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await digest('SHA-256', enc.encode(text))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time comparison of two strings (app keys). */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

// --- user tokens (HS256 JWT) ---

/** Longest lifetime of a user token, seconds (DECISIONS 14: short-lived, minted by the customer's backend). */
export const USER_TOKEN_MAX_TTL_S = 15 * 60
/** Allowed clock skew between the customer's backend and the pleatkit servers, seconds. */
export const CLOCK_SKEW_S = 60

export type UserRole = 'user' | 'admin'

export interface UserTokenClaims {
  /** The signed-in user (the same id the runtime uses). */
  sub: string
  /** App id (store namespace). */
  app: string
  /** Customer organization (tenant) of the user; `default` when the app has no organizations. */
  org?: string
  /** `admin` may use /admin routes of the app. Default `user`. */
  role?: UserRole
  /** Environment of the app (`production`, `staging`, ...), recorded on every row. */
  env?: string
  iat: number
  exp: number
}

export interface MintUserTokenOptions {
  /** The app's user-JWT secret (server side only, never in the browser). */
  secret: string
  userId: string
  appId: string
  orgId?: string
  role?: UserRole
  environment?: string
  /** Lifetime in seconds, at most 900 (default). */
  ttlSeconds?: number
  /** Override the clock (tests). Seconds since the epoch. */
  now?: number
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return subtle().importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
}

/**
 * Mint a user token for the browser (call it in the customer's backend, after its own sign-in check).
 * HS256, at most 15 minutes. The browser sends it as `Authorization: Bearer <token>` to store-server and the
 * agent server, which verify it with the same secret.
 */
export async function mintUserToken(o: MintUserTokenOptions): Promise<string> {
  if (!o.secret || o.secret.length < 32) throw new Error('mintUserToken: the secret must be at least 32 characters')
  if (!o.userId || !o.appId) throw new Error('mintUserToken: userId and appId are required')
  const ttl = o.ttlSeconds ?? USER_TOKEN_MAX_TTL_S
  if (!(ttl > 0 && ttl <= USER_TOKEN_MAX_TTL_S)) throw new Error(`mintUserToken: ttlSeconds must be between 1 and ${USER_TOKEN_MAX_TTL_S}`)
  const iat = Math.floor(o.now ?? Date.now() / 1000)
  const claims: UserTokenClaims = {
    sub: o.userId,
    app: o.appId,
    ...(o.orgId ? { org: o.orgId } : {}),
    role: o.role ?? 'user',
    ...(o.environment ? { env: o.environment } : {}),
    iat,
    exp: iat + ttl,
  }
  const head = toBase64Url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const body = toBase64Url(enc.encode(JSON.stringify(claims)))
  const sig = new Uint8Array(await subtle().sign('HMAC', await hmacKey(o.secret, 'sign'), enc.encode(`${head}.${body}`)))
  return `${head}.${body}.${toBase64Url(sig)}`
}

export class TokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TokenError'
  }
}

/** Verify a user token: HS256 only, valid signature, not expired, lifetime at most 15 minutes. */
export async function verifyUserToken(token: string, secret: string, options: { now?: number } = {}): Promise<UserTokenClaims> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new TokenError('malformed token')
  const [head, body, sig] = parts as [string, string, string]
  let header: { alg?: string }
  let claims: Partial<UserTokenClaims>
  try {
    header = JSON.parse(dec.decode(fromBase64(head))) as { alg?: string }
    claims = JSON.parse(dec.decode(fromBase64(body))) as Partial<UserTokenClaims>
  } catch {
    throw new TokenError('malformed token')
  }
  // never trust the header's choice of algorithm beyond this exact value ("none", RS256 confusion)
  if (header.alg !== 'HS256') throw new TokenError('unsupported token algorithm')
  const ok = await subtle().verify('HMAC', await hmacKey(secret, 'verify'), buf(fromBase64(sig)), enc.encode(`${head}.${body}`))
  if (!ok) throw new TokenError('bad token signature')
  const now = Math.floor(options.now ?? Date.now() / 1000)
  if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.app !== 'string' || !claims.app) throw new TokenError('token needs sub and app')
  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') throw new TokenError('token needs iat and exp')
  if (claims.exp < now - CLOCK_SKEW_S) throw new TokenError('token expired')
  if (claims.iat > now + CLOCK_SKEW_S) throw new TokenError('token issued in the future')
  if (claims.exp - claims.iat > USER_TOKEN_MAX_TTL_S) throw new TokenError(`token lifetime is longer than ${USER_TOKEN_MAX_TTL_S} s`)
  if (claims.role !== undefined && claims.role !== 'user' && claims.role !== 'admin') throw new TokenError('bad role')
  return claims as UserTokenClaims
}

// --- app keys and bundle signatures (ed25519) ---

/** Shape of an app key (server to server secret): `mk_live_` or `mk_test_` and at least 24 more characters. */
export const APP_KEY_RE = /^mk_(live|test)_[A-Za-z0-9_-]{24,}$/

export function isAppKey(key: string | undefined | null): key is string {
  return typeof key === 'string' && APP_KEY_RE.test(key)
}

/** A fresh random app key (`pleatkit keys new`). */
export function newAppKey(kind: 'live' | 'test' = 'live'): string {
  return `mk_${kind}_${toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(24)))}`
}

const PKCS8_ED25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])

export interface SigningKey {
  privateKey: CryptoKey
  /** Raw 32-byte public key, base64url: what the app's build passes to the runtime as `publicKey`. */
  publicKey: string
  /** Short id of the public key, recorded in signatures. */
  keyId: string
}

/** ed25519 key pair of an app, derived from its app key with HKDF-SHA256 (no second secret to manage). */
export async function signingKeyFromAppKey(appKey: string): Promise<SigningKey> {
  if (!isAppKey(appKey)) throw new Error('signingKeyFromAppKey: not an app key (mk_live_… / mk_test_…)')
  const ikm = await subtle().importKey('raw', enc.encode(appKey), 'HKDF', false, ['deriveBits'])
  const seed = new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('pleatkit'), info: enc.encode('bundle-signing/v1') }, ikm, 256))
  const der = new Uint8Array(48)
  der.set(PKCS8_ED25519)
  der.set(seed, 16)
  const privateKey = await subtle().importKey('pkcs8', der, { name: 'Ed25519' }, true, ['sign'])
  const jwk = await subtle().exportKey('jwk', privateKey)
  const publicKey = jwk.x!
  return { privateKey, publicKey, keyId: (await sha256Hex(publicKey)).slice(0, 16) }
}

/** The public key (base64url) that belongs to an app key. */
export async function publicKeyFromAppKey(appKey: string): Promise<string> {
  return (await signingKeyFromAppKey(appKey)).publicKey
}

/** What a bundle signature covers. Every field is checked by the runtime before the bundle runs. */
export interface BundleSignaturePayload {
  v: 1
  /** App (store namespace) the bundle was compiled for; a bundle never runs in another app. */
  app: string
  /** Bundle key (content address, see `bundleKey`). */
  key: string
  /** sha256 of the snapshot files the bundle was compiled from. */
  filesHash: string
  /** Subresource-integrity digests of the JS and CSS files. */
  js: string
  css: string
  /** Host modules the bundle imports (resolved before it runs, so externals can be lazy). */
  externals: string[]
  /** Compiler that produced it (`COMPILER_VERSION`). */
  compiler: string
  createdAt: string
}

/** `<key>.json` next to `<key>.js` and `<key>.css`. `sig` is absent on unsigned (dev) bundles. */
export interface BundleSignature {
  payload: BundleSignaturePayload
  sig?: string
  keyId?: string
}

/** Canonical bytes of a payload: keys in a fixed order, so signer and verifier agree. */
export function canonicalPayload(p: BundleSignaturePayload): string {
  return JSON.stringify([p.v, p.app, p.key, p.filesHash, p.js, p.css, [...p.externals].sort(), p.compiler, p.createdAt])
}

export async function signBundle(payload: BundleSignaturePayload, key: SigningKey): Promise<BundleSignature> {
  const sig = new Uint8Array(await subtle().sign({ name: 'Ed25519' }, key.privateKey, enc.encode(canonicalPayload(payload))))
  return { payload, sig: toBase64Url(sig), keyId: key.keyId }
}

export class SignatureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SignatureError'
  }
}

/** Throws SignatureError unless `sig` is a valid ed25519 signature of the payload by `publicKey`. */
export async function verifyBundleSignature(signature: BundleSignature, publicKey: string): Promise<void> {
  if (!signature.sig) throw new SignatureError('bundle is not signed')
  let key: CryptoKey
  try {
    key = await subtle().importKey('raw', buf(fromBase64(publicKey)), { name: 'Ed25519' }, false, ['verify'])
  } catch (e) {
    throw new SignatureError(`cannot use the configured public key: ${(e as Error).message}`)
  }
  const ok = await subtle().verify({ name: 'Ed25519' }, key, buf(fromBase64(signature.sig)), enc.encode(canonicalPayload(signature.payload)))
  if (!ok) throw new SignatureError('bad bundle signature')
}
