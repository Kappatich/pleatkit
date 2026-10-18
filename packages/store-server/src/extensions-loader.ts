import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { StoreExtension } from './extension.js'

/** Env variable that names the extension modules to load: a comma-separated list, or `none`. */
export const EXTENSIONS_ENV = 'PLEATKIT_STORE_EXTENSIONS'
/** The managed cloud's modules (private package); loaded when it is installed next to the store and nothing else is named. */
export const CLOUD_PACKAGE = '@pleatkit/store-cloud'

type Env = Record<string, string | undefined>
type Factory = (env: Env) => StoreExtension | StoreExtension[]

/**
 * DECISIONS 70.1: the extensions the `pleatkit-store` binary runs with. An extension module's default export is a
 * factory `(env) => StoreExtension | StoreExtension[]`. Modules resolve from `cwd` (the deployment), so the open
 * package never depends on a closed one:
 * - `PLEATKIT_STORE_EXTENSIONS=none`: the open core only;
 * - `PLEATKIT_STORE_EXTENSIONS=<module>[,<module>]`: those, and a missing one is an error;
 * - unset: `@pleatkit/store-cloud` when it is installed, otherwise the open core.
 */
export async function loadExtensions(env: Env, cwd = process.cwd()): Promise<{ extensions: StoreExtension[]; modules: string[] }> {
  const named = env[EXTENSIONS_ENV]?.trim()
  if (named === 'none') return { extensions: [], modules: [] }
  const specs = named ? named.split(',').map((s) => s.trim()).filter(Boolean) : [CLOUD_PACKAGE]
  const req = createRequire(path.join(path.resolve(cwd), 'package.json'))
  const extensions: StoreExtension[] = []
  const modules: string[] = []
  for (const spec of specs) {
    let file: string
    try {
      file = req.resolve(spec)
    } catch (e) {
      if (!named) continue
      throw new Error(`${EXTENSIONS_ENV}: cannot find "${spec}" from ${cwd}: ${(e as Error).message.split('\n')[0]}`)
    }
    const mod = (await import(pathToFileURL(file).href)) as { default?: Factory }
    if (typeof mod.default !== 'function') throw new Error(`${spec}: the default export must be a factory (env) => StoreExtension`)
    const made = mod.default(env)
    extensions.push(...(Array.isArray(made) ? made : [made]))
    modules.push(spec)
  }
  return { extensions, modules }
}
