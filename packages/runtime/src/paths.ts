// Path helpers shared by the browser runtime, the agent server and the Vite plugin (code review 06 §4: one copy).

/** Files the agent and the user may write in the dynamic zone. */
export const WRITABLE_EXT = /\.(tsx|ts|jsx|js|css|json)$/

/** `a/./b/../c` → `a/c`; leading and duplicate slashes dropped. Posix paths only. */
export function normalizePath(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

export function dirnameOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}

/**
 * May `path` be written as part of the dynamic zone? Project-relative posix paths only: no `..`, no leading
 * slash, no backslash (a Windows path such as `src\dynamic\x.tsx` is refused, never normalized), a known
 * extension, under one of the zone roots.
 */
export function isWritablePath(path: string, dynamicRoots: string[]): boolean {
  if (typeof path !== 'string' || !path || path.includes('..') || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false
  if (!WRITABLE_EXT.test(path)) return false
  return dynamicRoots.some((r) => r !== '' && path.startsWith(r))
}

/**
 * Problems of a zone glob as written in the Vite plugin options (code review 06 §1: `./src/dynamic/**` used to
 * make the zone silently non-editable). Returns the normalized glob and what was wrong with it.
 */
export function validateZoneGlob(glob: string): { glob: string; problems: string[] } {
  const problems: string[] = []
  let g = glob
  if (g.includes('\\')) {
    problems.push(`"${glob}" uses backslashes; zone globs are posix paths (src/dynamic/**)`)
    g = g.replace(/\\/g, '/')
  }
  if (g.startsWith('./')) g = g.replace(/^(\.\/)+/, '')
  if (g.startsWith('/') || /^[A-Za-z]:/.test(g)) problems.push(`"${glob}" is absolute; zone globs are relative to the project root`)
  if (g.split('/').includes('..')) problems.push(`"${glob}" leaves the project root`)
  if (/^[*{[!?]/.test(g)) problems.push(`"${glob}" has no fixed directory; put the zone in its own folder such as src/dynamic/**`)
  return { glob: g, problems }
}
