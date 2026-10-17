import type { FileMap } from './types.js'

export const RESOLVE_EXTENSIONS = ['', '.tsx', '.ts', '.jsx', '.js', '.css', '.json', '/index.tsx', '/index.ts', '/index.js']

export interface ResolveContext {
  files: FileMap
  alias: Record<string, string>
  externals: string[]
  externalPatterns: string[]
}

export type Resolution =
  | { kind: 'file'; path: string }
  | { kind: 'external'; name: string }
  | { kind: 'missing'; text: string }

function normalize(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}

export function matchesExternal(spec: string, ctx: Pick<ResolveContext, 'externals' | 'externalPatterns'>): boolean {
  if (ctx.externals.includes(spec)) return true
  return ctx.externalPatterns.some((p) => (p.endsWith('*') ? spec.startsWith(p.slice(0, -1)) && spec.length >= p.length : p === spec))
}

/** `@/lib/utils` → `src/lib/utils`; null when the spec has no alias. */
export function applyAlias(spec: string, alias: Record<string, string>): string | null {
  for (const [key, dir] of Object.entries(alias)) {
    const d = dir.replace(/\/$/, '')
    if (spec === key) return d
    if (spec.startsWith(key + '/')) return d + spec.slice(key.length)
  }
  return null
}

/** `src/lib/utils` → `@/lib/utils`, so relative imports of host files still match aliased externals. */
function toAliasSpec(projectPath: string, alias: Record<string, string>): string | null {
  for (const [key, dir] of Object.entries(alias)) {
    const d = dir.replace(/\/$/, '')
    if (projectPath === d) return key
    if (projectPath.startsWith(d + '/')) return key + projectPath.slice(d.length)
  }
  return null
}

/**
 * Resolve an import from dynamic code. Files come only from the FileMap; everything the host provides
 * must be listed in externals. Anything else is an error the agent can read and fix.
 */
export function resolveSpecifier(spec: string, importer: string, ctx: ResolveContext): Resolution {
  if (matchesExternal(spec, ctx)) return { kind: 'external', name: spec }

  let projectPath: string | null
  if (spec.startsWith('./') || spec.startsWith('../')) projectPath = normalize(dirname(importer) + '/' + spec)
  else if (spec.startsWith('/')) projectPath = normalize(spec)
  else projectPath = applyAlias(spec, ctx.alias)

  if (projectPath === null) {
    return { kind: 'missing', text: `Package "${spec}" is not available to dynamic code. Allowed externals: ${ctx.externalPatterns.join(', ')}` }
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    if (Object.prototype.hasOwnProperty.call(ctx.files, projectPath + ext)) return { kind: 'file', path: projectPath + ext }
  }
  const aliased = toAliasSpec(projectPath.replace(/\.(tsx|ts|jsx|js)$/, ''), ctx.alias)
  if (aliased && matchesExternal(aliased, ctx)) return { kind: 'external', name: aliased }
  return { kind: 'missing', text: `Cannot resolve "${spec}": no such file in the dynamic zone and not an allowed external` }
}

export function loaderFor(path: string): 'tsx' | 'ts' | 'jsx' | 'js' | 'css' | 'json' {
  const ext = path.slice(path.lastIndexOf('.') + 1)
  switch (ext) {
    case 'ts':
    case 'mts':
      return 'ts'
    case 'jsx':
      return 'jsx'
    case 'js':
    case 'mjs':
      return 'js'
    case 'css':
      return 'css'
    case 'json':
      return 'json'
    default:
      return 'tsx'
  }
}
