import { digest } from './sha.js'
import type { FileMap } from './types.js'

/** sha256 over the FileMap with sorted keys, so key order never changes the hash. */
export async function hashFiles(files: FileMap): Promise<string> {
  const sorted = Object.keys(files)
    .sort()
    .map((k) => [k, files[k]])
  const data = new TextEncoder().encode(JSON.stringify(sorted))
  // WebCrypto when the page has it; a JS fallback on insecure (plain http) pages (code review 06 item 4)
  return [...(await digest('SHA-256', data))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
let lastTime = -1
let lastRandom: number[] = []

/** Monotonic ULID: lexicographic order matches creation order, even within one millisecond. */
export function ulid(now: number = Date.now()): string {
  if (now <= lastTime) {
    now = lastTime
    let i = lastRandom.length - 1
    while (i >= 0 && lastRandom[i] === 31) lastRandom[i--] = 0
    if (i >= 0) lastRandom[i]! += 1
  } else {
    lastTime = now
    lastRandom = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b % 32)
  }
  let time = ''
  let t = now
  for (let i = 0; i < 10; i++) {
    time = ENCODING[t % 32] + time
    t = Math.floor(t / 32)
  }
  return time + lastRandom.map((r) => ENCODING[r]).join('')
}

export const clone = <T>(v: T): T => structuredClone(v)
