// Server compile mode (V1 B1): the agent server compiles a snapshot with native esbuild, signs the bundle with
// the app key, and the browser loads it from the app's origin. This module is the browser's side of it.

import { BUNDLE_FORMAT, COMPILER_VERSION } from './constants.js'
import { sha256Hex, sriDigest, verifyBundleSignature, type BundleSignature } from './security.js'
import type { CompileError, CompiledBundle, FileMap, MorphkitManifest } from './types.js'

/** Everything besides the files that changes what a bundle compiles to: externals, aliases, CSS input, readonly sources. */
export async function contextHash(
  manifest: Pick<MorphkitManifest, 'externals' | 'externalPatterns' | 'alias' | 'dynamicRoots' | 'css'>,
  readonly: FileMap,
): Promise<string> {
  const ro = Object.keys(readonly)
    .sort()
    .map((p) => [p, readonly[p]])
  return sha256Hex(
    JSON.stringify([
      [...manifest.externals].sort(),
      [...manifest.externalPatterns].sort(),
      Object.entries(manifest.alias).sort(),
      [...manifest.dynamicRoots].sort(),
      manifest.css?.hash ?? null,
      ro,
    ]),
  )
}

export interface BundleKeyInput {
  namespace: string
  filesHash: string
  contextHash: string
  cssMode: string
}

/**
 * Content address of a bundle (F4): the compiler version, the bundle format, the app instance, the CSS mode,
 * the context and the files. The browser and the agent server compute it the same way, so a page can ask for
 * a bundle without asking the server to compile first.
 */
export async function bundleKey(i: BundleKeyInput): Promise<string> {
  return (await sha256Hex(JSON.stringify(['mk-bundle', BUNDLE_FORMAT, COMPILER_VERSION, i.namespace, i.cssMode, i.contextHash, i.filesHash]))).slice(0, 40)
}

export interface ServerCompileResult {
  ok: boolean
  errors: CompileError[]
  key?: string
  timeMs: number
}

export interface ServerBundlesOptions {
  /** Agent server, e.g. `/agent`. */
  agentUrl: string
  /** Where signed bundles are served from the app's origin, e.g. `/morphkit/b` (proxied to store-server or the agent). */
  bundleUrl: string
  namespace: string
  /** Bundles must be signed by this key (base64url ed25519); null accepts unsigned bundles (development). */
  publicKey: string | null
  /** User token for the agent server (production). */
  token?: ((options?: { refresh?: boolean }) => Promise<string | undefined> | string | undefined) | string
  /** A fresh token after the agent server answered 401 (brainstorm 05 #19). */
  onAuthExpired?: () => Promise<string | null | undefined> | string | null | undefined
  /** Timeout of a compile request, ms. Default 60 000. Bundle files: 15 000. */
  timeoutMs?: number
  fetch?: typeof fetch
}

export class BundleVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BundleVerificationError'
  }
}

/** Ask the agent server to compile (and sign and store) a snapshot, and load signed bundles by key. */
export class ServerBundles {
  constructor(private readonly o: ServerBundlesOptions) {}

  private get fetchFn(): typeof fetch {
    return this.o.fetch ?? ((...a) => globalThis.fetch(...a))
  }

  private base(): string {
    return this.o.bundleUrl.replace(/\/$/, '')
  }

  urlOf(key: string, ext: 'js' | 'css' | 'json'): string {
    return `${this.base()}/${encodeURIComponent(this.o.namespace)}/${key}.${ext}`
  }

  async compile(body: {
    userId: string
    files: FileMap
    readonly: FileMap
    manifest: Pick<MorphkitManifest, 'alias' | 'externals' | 'externalPatterns' | 'dynamicRoots' | 'css'>
    components: string[]
    check?: boolean
  }): Promise<ServerCompileResult> {
    const m = body.manifest
    const send = async (token: string | null | undefined) => this.fetchFn(`${this.o.agentUrl.replace(/\/$/, '')}/v1/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        appId: this.o.namespace,
        userId: body.userId,
        files: body.files,
        readonly: body.readonly,
        components: body.components,
        context: { alias: m.alias, externals: m.externals, externalPatterns: m.externalPatterns, dynamicRoots: m.dynamicRoots, namespace: this.o.namespace, ...(m.css ? { css: m.css } : {}) },
        ...(body.check ? { check: true } : {}),
      }),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 60_000),
    })
    let res = await send(typeof this.o.token === 'function' ? await this.o.token() : this.o.token)
    if (res.status === 401) {
      const fresh = this.o.onAuthExpired ? await this.o.onAuthExpired() : typeof this.o.token === 'function' ? await this.o.token({ refresh: true }) : null
      if (fresh) res = await send(fresh)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`morphkit: the agent server could not compile (${res.status}): ${text.slice(0, 300)}`)
    }
    return (await res.json()) as ServerCompileResult
  }

  /**
   * The bundle for `key`, verified: the signature (when a public key is configured), that it was made for this
   * app instance and these files, and the CSS digest. The JS digest is enforced by the browser on load (SRI).
   * Null when the server has no such bundle.
   */
  async load(key: string, filesHash: string): Promise<CompiledBundle | null> {
    const res = await this.fetchFn(this.urlOf(key, 'json'), { signal: AbortSignal.timeout(15_000) })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`morphkit: could not load the bundle signature (${res.status})`)
    const sig = (await res.json()) as BundleSignature
    const p = sig.payload
    if (!p || p.key !== key) throw new BundleVerificationError('the bundle signature is for another bundle')
    if (this.o.publicKey) {
      try {
        await verifyBundleSignature(sig, this.o.publicKey)
      } catch (e) {
        throw new BundleVerificationError(`refusing an unsigned or tampered bundle: ${(e as Error).message}`)
      }
    }
    if (p.app !== this.o.namespace) throw new BundleVerificationError(`the bundle was made for app "${p.app}"`)
    if (p.filesHash !== filesHash) throw new BundleVerificationError('the bundle was made from other files')
    const cssRes = await this.fetchFn(this.urlOf(key, 'css'), { signal: AbortSignal.timeout(15_000) })
    if (!cssRes.ok) throw new Error(`morphkit: could not load the bundle CSS (${cssRes.status})`)
    const css = await cssRes.text()
    if ((await sriDigest(css)) !== p.css) throw new BundleVerificationError('the bundle CSS does not match its signed digest')
    return { js: '', css, url: this.urlOf(key, 'js'), integrity: p.js, externals: p.externals }
  }
}
