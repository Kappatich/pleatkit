// Pure-JS SHA-256 and SHA-384 for pages without WebCrypto (code review 06 item 4). `crypto.subtle` exists only
// in secure contexts: an intranet app on plain http:// (not localhost) has none, and pleatkit used to stay in
// `loading` forever there. Hashing (file hashes, bundle keys, CSS digests) falls back to this code; signature
// checks cannot (ed25519 needs WebCrypto) and refuse with a clear message instead.

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function pad(bytes: Uint8Array, block: number, lengthBytes: number): Uint8Array {
  const bitLen = BigInt(bytes.length) * 8n
  const total = Math.ceil((bytes.length + 1 + lengthBytes) / block) * block
  const out = new Uint8Array(total)
  out.set(bytes)
  out[bytes.length] = 0x80
  for (let i = 0; i < lengthBytes; i++) out[total - 1 - i] = Number((bitLen >> BigInt(8 * i)) & 0xffn)
  return out
}

export function sha256Bytes(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const m = pad(data, 64, 8)
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < m.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = (m[off + 4 * i]! << 24) | (m[off + 4 * i + 1]! << 16) | (m[off + 4 * i + 2]! << 8) | m[off + 4 * i + 3]!
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[]
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)
      const ch = (e! & f!) ^ (~e! & g!)
      const t1 = (hh! + S1 + ch + K256[i]! + w[i]!) >>> 0
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!)
      const t2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d! + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (h[0]! + a!) >>> 0
    h[1] = (h[1]! + b!) >>> 0
    h[2] = (h[2]! + c!) >>> 0
    h[3] = (h[3]! + d!) >>> 0
    h[4] = (h[4]! + e!) >>> 0
    h[5] = (h[5]! + f!) >>> 0
    h[6] = (h[6]! + g!) >>> 0
    h[7] = (h[7]! + hh!) >>> 0
  }
  const out = new Uint8Array(32)
  for (let i = 0; i < 8; i++) {
    out[4 * i] = h[i]! >>> 24
    out[4 * i + 1] = (h[i]! >>> 16) & 0xff
    out[4 * i + 2] = (h[i]! >>> 8) & 0xff
    out[4 * i + 3] = h[i]! & 0xff
  }
  return out
}

const K512 = [
  '428a2f98d728ae22', '7137449123ef65cd', 'b5c0fbcfec4d3b2f', 'e9b5dba58189dbbc', '3956c25bf348b538', '59f111f1b605d019', '923f82a4af194f9b', 'ab1c5ed5da6d8118',
  'd807aa98a3030242', '12835b0145706fbe', '243185be4ee4b28c', '550c7dc3d5ffb4e2', '72be5d74f27b896f', '80deb1fe3b1696b1', '9bdc06a725c71235', 'c19bf174cf692694',
  'e49b69c19ef14ad2', 'efbe4786384f25e3', '0fc19dc68b8cd5b5', '240ca1cc77ac9c65', '2de92c6f592b0275', '4a7484aa6ea6e483', '5cb0a9dcbd41fbd4', '76f988da831153b5',
  '983e5152ee66dfab', 'a831c66d2db43210', 'b00327c898fb213f', 'bf597fc7beef0ee4', 'c6e00bf33da88fc2', 'd5a79147930aa725', '06ca6351e003826f', '142929670a0e6e70',
  '27b70a8546d22ffc', '2e1b21385c26c926', '4d2c6dfc5ac42aed', '53380d139d95b3df', '650a73548baf63de', '766a0abb3c77b2a8', '81c2c92e47edaee6', '92722c851482353b',
  'a2bfe8a14cf10364', 'a81a664bbc423001', 'c24b8b70d0f89791', 'c76c51a30654be30', 'd192e819d6ef5218', 'd69906245565a910', 'f40e35855771202a', '106aa07032bbd1b8',
  '19a4c116b8d2d0c8', '1e376c085141ab53', '2748774cdf8eeb99', '34b0bcb5e19b48a8', '391c0cb3c5c95a63', '4ed8aa4ae3418acb', '5b9cca4f7763e373', '682e6ff3d6b2b8a3',
  '748f82ee5defb2fc', '78a5636f43172f60', '84c87814a1f0ab72', '8cc702081a6439ec', '90befffa23631e28', 'a4506cebde82bde9', 'bef9a3f7b2c67915', 'c67178f2e372532b',
  'ca273eceea26619c', 'd186b8c721c0c207', 'eada7dd6cde0eb1e', 'f57d4f7fee6ed178', '06f067aa72176fba', '0a637dc5a2c898a6', '113f9804bef90dae', '1b710b35131c471b',
  '28db77f523047d84', '32caab7b40c72493', '3c9ebe0a15c9bebc', '431d67c49c100d4c', '4cc5d4becb3e42b6', '597f299cfc657e2a', '5fcb6fab3ad6faec', '6c44198c4a475817',
].map((x) => BigInt('0x' + x))

/** SHA-384 (SHA-512 family, BigInt arithmetic): the digest Subresource Integrity uses. Slow, but CSS is small. */
export function sha384Bytes(data: Uint8Array): Uint8Array {
  const M = (1n << 64n) - 1n
  const h = ['cbbb9d5dc1059ed8', '629a292a367cd507', '9159015a3070dd17', '152fecd8f70e5939', '67332667ffc00b31', '8eb44a8768581511', 'db0c2e0d64f98fa7', '47b5481dbefa4fa4'].map((x) => BigInt('0x' + x))
  const m = pad(data, 128, 16)
  const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & M
  const w: bigint[] = new Array(80)
  for (let off = 0; off < m.length; off += 128) {
    for (let i = 0; i < 16; i++) {
      let v = 0n
      for (let j = 0; j < 8; j++) v = (v << 8n) | BigInt(m[off + 8 * i + j]!)
      w[i] = v
    }
    for (let i = 16; i < 80; i++) {
      const s0 = rotr(w[i - 15]!, 1n) ^ rotr(w[i - 15]!, 8n) ^ (w[i - 15]! >> 7n)
      const s1 = rotr(w[i - 2]!, 19n) ^ rotr(w[i - 2]!, 61n) ^ (w[i - 2]! >> 6n)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) & M
    }
    let [a, b, c, d, e, f, g, hh] = h as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
    for (let i = 0; i < 80; i++) {
      const S1 = rotr(e, 14n) ^ rotr(e, 18n) ^ rotr(e, 41n)
      const ch = (e & f) ^ (~e & M & g)
      const t1 = (hh + S1 + ch + K512[i]! + w[i]!) & M
      const S0 = rotr(a, 28n) ^ rotr(a, 34n) ^ rotr(a, 39n)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) & M
      hh = g
      g = f
      f = e
      e = (d + t1) & M
      d = c
      c = b
      b = a
      a = (t1 + t2) & M
    }
    const add = [a, b, c, d, e, f, g, hh]
    for (let i = 0; i < 8; i++) h[i] = (h[i]! + add[i]!) & M
  }
  const out = new Uint8Array(48)
  for (let i = 0; i < 6; i++) for (let j = 0; j < 8; j++) out[8 * i + j] = Number((h[i]! >> BigInt(56 - 8 * j)) & 0xffn)
  return out
}

/** WebCrypto's digest when the page has it, the JS implementation otherwise. */
export async function digest(algorithm: 'SHA-256' | 'SHA-384', data: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle
  if (subtle) return new Uint8Array(await subtle.digest(algorithm, data as unknown as ArrayBuffer))
  return algorithm === 'SHA-256' ? sha256Bytes(data) : sha384Bytes(data)
}

/** Is WebCrypto there? False on plain http:// pages that are not localhost (insecure context). */
export const hasWebCrypto = (): boolean => Boolean(globalThis.crypto?.subtle)
