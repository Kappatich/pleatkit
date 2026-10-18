import fs from 'node:fs'
import type { PleatkitManifest } from '@pleatkit/vite-plugin'

export interface CheckSnapshotsArgs {
  store: string
  app: string
  manifest: string
  key?: string
  typecheck?: boolean
  /** App folder for package types when type checking (default: the manifest's folder's parent). */
  root?: string
}

/**
 * `pleatkit check-snapshots` (brainstorm 05 #4): every user's current version against a new build, before the
 * release goes out. The checking code is the agent server's (`@pleatkit/agent`), loaded only for this command.
 */
export async function checkSnapshotsCommand(a: CheckSnapshotsArgs): Promise<{ ok: boolean; lines: string[] }> {
  const agent = (await import('@pleatkit/agent').catch(() => null)) as typeof import('@pleatkit/agent') | null
  if (!agent) return { ok: false, lines: ['check-snapshots needs @pleatkit/agent: pnpm add -D @pleatkit/agent'] }
  if (!fs.existsSync(a.manifest)) return { ok: false, lines: [`no manifest at ${a.manifest}: run your build (vite build) first`] }
  const manifest = JSON.parse(fs.readFileSync(a.manifest, 'utf8')) as PleatkitManifest
  const typecheck = a.typecheck ? agent.createTypechecker({ root: a.root ?? null }) : null
  const r = await agent.checkSnapshots({ storeUrl: a.store, appId: a.app, manifest, appKey: a.key ?? null, typecheck })
  const lines = [`checked ${r.checked} personal version(s) of ${a.app} against ${a.manifest}${a.typecheck ? ' (with type check)' : ''}`]
  for (const x of r.results) {
    lines.push(`${x.ok ? '[ok]  ' : '[FAIL]'} ${x.userId} ${x.snapshotId} (changed: ${x.userFiles.join(', ') || 'none'})`)
    for (const e of x.errors) lines.push(`         ${e.file}${e.line ? `:${e.line}:${e.column}` : ''} ${e.text}`)
  }
  lines.push('', r.failed ? `${r.failed} version(s) would be marked stale after this release; users keep them and are asked to reset or let the agent carry them over` : 'every version carries over to this release')
  return { ok: r.failed === 0, lines }
}
