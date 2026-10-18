import fs from 'node:fs'
import { validateZoneGlob, type AgentRunRequest, type CompileContextWire, type FileMap, type PleatkitManifest } from '@pleatkit/runtime/compiler'

/**
 * Where the agent server gets the app's manifest (code review 06 item 8): the context of the static rules
 * (externals, zone roots, protected elements), the readonly sources and the core types come from the server's own
 * copy of the app's build, never from the request body. A browser that sends `externalPatterns: ['*']` changes
 * nothing then.
 *
 * - a manifest object (tests, embedding),
 * - a function of the app id,
 * - `PLEATKIT_MANIFEST`: a path to `dist/pleatkit.manifest.json` or an http(s) URL of it (re-read when it changes),
 *   `PLEATKIT_MANIFESTS`: `{ "<appId>": "<path or URL>" }` for several apps.
 */
export type ManifestSource = PleatkitManifest | ((appId: string) => PleatkitManifest | null | Promise<PleatkitManifest | null>)

const cache = new Map<string, { at: number; mtime: number; manifest: PleatkitManifest }>()

/** Load a manifest from a file (re-read when its mtime changes) or a URL (cached 5 s). */
export async function loadManifest(location: string, fetchFn: typeof fetch = (...a) => globalThis.fetch(...a)): Promise<PleatkitManifest> {
  const hit = cache.get(location)
  if (/^https?:\/\//.test(location)) {
    if (hit && Date.now() - hit.at < 5_000) return hit.manifest
    const res = await fetchFn(location, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) throw new Error(`could not load the app manifest from ${location}: ${res.status}`)
    const manifest = (await res.json()) as PleatkitManifest
    cache.set(location, { at: Date.now(), mtime: 0, manifest })
    return manifest
  }
  const mtime = fs.statSync(location).mtimeMs
  if (hit && hit.mtime === mtime) return hit.manifest
  const manifest = JSON.parse(fs.readFileSync(location, 'utf8')) as PleatkitManifest
  if (manifest.version !== 1 || !Array.isArray(manifest.dynamicRoots)) throw new Error(`${location} is not a pleatkit manifest`)
  cache.set(location, { at: Date.now(), mtime, manifest })
  return manifest
}

/** `PLEATKIT_MANIFEST` / `PLEATKIT_MANIFESTS` → a ManifestSource, or null when neither is set. */
export function manifestSourceFromEnv(env: Record<string, string | undefined>): ManifestSource | null {
  const one = env.PLEATKIT_MANIFEST
  let many: Record<string, string> | null = null
  if (env.PLEATKIT_MANIFESTS) {
    try {
      many = JSON.parse(env.PLEATKIT_MANIFESTS) as Record<string, string>
    } catch {
      throw new Error('PLEATKIT_MANIFESTS must be JSON: {"<appId>": "<path or URL of pleatkit.manifest.json>"}')
    }
  }
  if (!one && !many) return null
  return async (appId) => {
    const where = many?.[appId] ?? one
    return where ? loadManifest(where) : null
  }
}

export async function resolveManifest(source: ManifestSource | null | undefined, appId: string): Promise<PleatkitManifest | null> {
  if (!source) return null
  return typeof source === 'function' ? await source(appId) : source
}

/** The compile context the server trusts, from its manifest. */
export function contextFromManifest(m: PleatkitManifest, namespace: string): CompileContextWire {
  return {
    alias: m.alias,
    externals: m.externals,
    externalPatterns: m.externalPatterns,
    dynamicRoots: m.dynamicRoots,
    namespace,
    ...(m.css ? { css: m.css } : {}),
  }
}

/** Panels of the release: dynamic files whose original source has a default export. */
export function manifestPanels(m: PleatkitManifest): string[] {
  return m.dynamic.filter((f) => /\.(tsx|ts|jsx|js)$/.test(f.path) && /export\s+default\b|as\s+default\b/.test(f.source)).map((f) => f.path)
}

const files = (list: { path: string; source: string }[]): FileMap => Object.fromEntries(list.map((f) => [f.path, f.source]))

export interface TrustedInput {
  context: CompileContextWire
  readonly: FileMap
  coreTypes: FileMap
  components: string[]
  protected: string[]
  base: FileMap
  /** The manifest, when the server has one (digests for the prompt). */
  manifest: PleatkitManifest | null
}

/**
 * Without a server manifest (development), the body's context is used, but a context that switches the rules off
 * is refused: a match-all externals pattern, zone roots outside the project.
 */
export function validateClientContext(ctx: CompileContextWire): void {
  for (const p of ctx.externalPatterns) {
    if (typeof p !== 'string' || p.trim() === '' || p.trim() === '*' || p.startsWith('*') || p === '/*' || /^https?:/.test(p)) {
      throw new Error(`context.externalPatterns: "${p}" would allow any import; list the modules dynamic code may use`)
    }
  }
  for (const r of ctx.dynamicRoots) {
    const { problems } = validateZoneGlob(r)
    if (typeof r !== 'string' || !r || problems.length) throw new Error(`context.dynamicRoots: "${r}" is not a zone root inside the project (${problems.join('; ')})`)
  }
}

/** What the run or compile may trust: the server manifest's view when there is one, else the checked body. */
export function trustedInput(manifest: PleatkitManifest | null, appId: string, body: Pick<AgentRunRequest, 'context' | 'readonly' | 'coreTypes' | 'components'>): TrustedInput {
  if (manifest) {
    const panels = manifestPanels(manifest)
    const components = [...new Set([...panels, ...body.components.filter((c) => manifest.dynamicRoots.some((r) => c.startsWith(r)))])].sort()
    return {
      context: contextFromManifest(manifest, appId),
      readonly: files(manifest.readonly),
      coreTypes: files(manifest.coreTypes),
      components,
      protected: manifest.protected ?? [],
      base: files(manifest.dynamic),
      manifest,
    }
  }
  validateClientContext(body.context)
  return { context: { ...body.context, namespace: appId }, readonly: body.readonly, coreTypes: body.coreTypes, components: body.components, protected: [], base: {}, manifest: null }
}
