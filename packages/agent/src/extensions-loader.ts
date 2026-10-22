import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentExtension } from './extension.js'

/** Env variable that names the extension modules to load: a comma-separated list, or `none`. */
export const AGENT_EXTENSIONS_ENV = 'PLEATKIT_AGENT_EXTENSIONS'
/** The managed cloud's modules (private package); loaded when the deployment depends on it and nothing else is named. */
export const AGENT_CLOUD_PACKAGE = '@pleatkit/agent-cloud'

type Env = Record<string, string | undefined>
type Factory = (env: Env) => AgentExtension | AgentExtension[]

/**
 * DECISIONS 89: the extensions the `pleatkit-agent` binary runs with, loaded the way the store loads its own. An
 * extension module's default export is a factory `(env) => AgentExtension | AgentExtension[]`. Modules resolve from
 * `cwd` (the deployment), so the open package never depends on a closed one:
 * - `PLEATKIT_AGENT_EXTENSIONS=none`: the open server only;
 * - `PLEATKIT_AGENT_EXTENSIONS=<module>[,<module>]`: those, and a missing one is an error;
 * - unset: `@pleatkit/agent-cloud` when the deployment (`cwd/package.json`) lists it as a dependency, otherwise
 *   none. Only a declared dependency counts (pnpm's hidden hoisting and NODE_PATH make packages resolvable that are
 *   not dependencies).
 */
export async function loadAgentExtensions(env: Env, cwd = process.cwd()): Promise<{ extensions: AgentExtension[]; modules: string[] }> {
  const named = env[AGENT_EXTENSIONS_ENV]?.trim()
  if (named === 'none') return { extensions: [], modules: [] }
  const specs = named ? named.split(',').map((s) => s.trim()).filter(Boolean) : dependsOnCloud(cwd) ? [AGENT_CLOUD_PACKAGE] : []
  const req = createRequire(path.join(path.resolve(cwd), 'package.json'))
  const extensions: AgentExtension[] = []
  const modules: string[] = []
  for (const spec of specs) {
    let file: string
    try {
      file = req.resolve(spec)
    } catch (e) {
      if (!named) continue
      throw new Error(`${AGENT_EXTENSIONS_ENV}: cannot find "${spec}" from ${cwd}: ${(e as Error).message.split('\n')[0]}`)
    }
    const mod = (await import(pathToFileURL(file).href)) as { default?: Factory }
    if (typeof mod.default !== 'function') throw new Error(`${spec}: the default export must be a factory (env) => AgentExtension`)
    const made = mod.default(env)
    extensions.push(...(Array.isArray(made) ? made : [made]))
    modules.push(spec)
  }
  return { extensions, modules }
}

function dependsOnCloud(cwd: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.resolve(cwd), 'package.json'), 'utf8')) as Record<string, unknown>
    if (pkg.name === AGENT_CLOUD_PACKAGE) return true
    return ['dependencies', 'optionalDependencies', 'devDependencies'].some((k) => Boolean((pkg[k] as Record<string, string> | undefined)?.[AGENT_CLOUD_PACKAGE]))
  } catch {
    return false
  }
}
