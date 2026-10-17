import fs from 'node:fs'
import { createRequire } from 'node:module'
import {
  bundleKey,
  COMPILER_VERSION,
  contextHash,
  extractCandidates,
  hashFiles,
  signBundle,
  signingKeyFromAppKey,
  sriDigest,
  type BundleSignature,
  type CompileContextWire,
  type CompileError,
  type FileMap,
  type SigningKey,
} from '@morphkit/runtime/compiler'
import type { AgentCredentials } from './auth.js'
import type { StoreClient } from './store-client.js'
import { Workspace } from './workspace.js'

const require = createRequire(import.meta.url)

/** What the browser (or the end of an agent run) sends to compile one snapshot on the server (V1 B1). */
export interface CompileInput {
  appId: string
  files: FileMap
  readonly: FileMap
  context: CompileContextWire
  /** Panels that must keep a default export. */
  components: string[]
  /** Protected elements and the release's original files (brainstorm 05 #20). */
  protected?: string[]
  base?: FileMap
}

export interface CompileOutput {
  ok: boolean
  errors: CompileError[]
  key?: string
  filesHash: string
  timeMs: number
}

interface StoredBundle {
  js: string
  css: string
  signature: BundleSignature
}

type TailwindCompile = (css: string, options: Record<string, unknown>) => Promise<{ build(candidates: string[]): string }>

/** The app's runtime CSS on the server: the same Tailwind compile the browser does, from the plugin's input. */
async function tailwindCss(input: string, sources: string[]): Promise<string> {
  const { compile } = (await import('tailwindcss')) as unknown as { compile: TailwindCompile }
  const compiler = await compile(input, {
    base: '/',
    loadStylesheet: async (id: string, base: string) => {
      const file = require.resolve(id)
      return { path: id, base, content: fs.readFileSync(file, 'utf8') }
    },
    loadModule: async (id: string) => {
      throw new Error(`Tailwind plugins/configs are not supported in runtime CSS ("${id}")`)
    },
  })
  return compiler.build(extractCandidates(sources))
}

/**
 * Compiles snapshots natively, signs the bundles with the app key and stores them where the browser loads them
 * from (store-server's public /v1/b/, or this process when there is no store). The same check as the agent's
 * `check` tool runs first, static rules included, so a signature also says "passed the rules".
 */
export class BundleService {
  private readonly cache = new Map<string, StoredBundle>()
  private signing: Promise<SigningKey> | null

  constructor(
    private readonly credentials: AgentCredentials | null,
    private readonly store: StoreClient | null,
    private readonly maxCached = 500,
  ) {
    this.signing = credentials ? signingKeyFromAppKey(credentials.appKey) : null
    // the first compile after start would otherwise pay for loading the Tailwind compiler (~100 ms)
    void import('tailwindcss').catch(() => undefined)
    // and for starting esbuild's native service
    void import('esbuild').then((e) => e.transform('')).catch(() => undefined)
  }

  async compile(input: CompileInput, options: { check?: boolean } = {}): Promise<CompileOutput> {
    const started = performance.now()
    const context = { ...input.context, namespace: input.context.namespace ?? input.appId }
    const ws = new Workspace({ files: input.files, readonly: input.readonly, coreTypes: {}, context, components: input.components, ...(input.protected?.length ? { protected: input.protected, base: input.base ?? {} } : {}) })
    const check = await ws.check()
    const filesHash = ws.lastHash ?? (await hashFiles(input.files))
    if (!check.ok || !ws.lastBundle) return { ok: false, errors: check.errors, filesHash, timeMs: Math.round(performance.now() - started) }
    const cssMode = context.css?.mode === 'tailwind' ? 'tailwind' : 'palette'
    const key = await bundleKey({ namespace: context.namespace, filesHash, contextHash: await contextHash(context, input.readonly), cssMode })
    if (options.check) return { ok: true, errors: [], key, filesHash, timeMs: Math.round(performance.now() - started) }
    if (!this.cache.has(this.cacheKey(input.appId, key))) {
      const sources = [...Object.values(input.readonly), ...Object.entries(input.files).filter(([p]) => !p.endsWith('.css')).map(([, s]) => s)]
      const tw = cssMode === 'tailwind' && context.css?.input ? await tailwindCss(context.css.input, sources) : ''
      const js = ws.lastBundle.js
      const css = [ws.lastBundle.css, tw].filter(Boolean).join('\n')
      const payload = {
        v: 1 as const,
        app: input.appId,
        key,
        filesHash,
        js: await sriDigest(js),
        css: await sriDigest(css),
        externals: ws.lastBundle.externals ?? [],
        compiler: COMPILER_VERSION,
        createdAt: new Date().toISOString(),
      }
      const signature: BundleSignature = this.signing ? await signBundle(payload, await this.signing) : { payload }
      this.remember(input.appId, key, { js, css, signature })
      // stored before the browser asks for it; without a store this process serves it
      if (this.store) await this.store.putBundle(input.appId, key, { js, css, signature })
    }
    return { ok: true, errors: [], key, filesHash, timeMs: Math.round(performance.now() - started) }
  }

  private cacheKey(appId: string, key: string): string {
    return `${appId}\0${key}`
  }

  private remember(appId: string, key: string, b: StoredBundle): void {
    this.cache.set(this.cacheKey(appId, key), b)
    if (this.cache.size > this.maxCached) this.cache.delete(this.cache.keys().next().value!)
  }

  /** `<key>.js|css|json` of a bundle this process compiled, or from store-server. */
  async file(appId: string, file: string): Promise<{ body: string; type: string } | null> {
    const m = /^([0-9a-f]{16,64})\.(js|css|json)$/.exec(file)
    if (!m) return null
    const [, key, ext] = m as unknown as [string, string, 'js' | 'css' | 'json']
    const type = ext === 'js' ? 'text/javascript; charset=utf-8' : ext === 'css' ? 'text/css; charset=utf-8' : 'application/json'
    const hit = this.cache.get(this.cacheKey(appId, key))
    if (hit) return { body: ext === 'js' ? hit.js : ext === 'css' ? hit.css : JSON.stringify(hit.signature), type }
    const res = await this.store?.bundleFile(appId, file).catch(() => null)
    return res ? { body: await res.text(), type } : null
  }
}
