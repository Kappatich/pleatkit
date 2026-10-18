import { COMPILER_VERSION } from './constants.js'
import { sha256Hex } from './security.js'
import { contextHash } from './server-bundles.js'
import type { FileMap, PleatkitManifest } from './types.js'
import { hashFiles } from './util.js'

/** sha256 per file: what the per-file `baseHash` of a snapshot is made of (V1 B5). */
export async function fileHashes(files: FileMap): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [p, s] of Object.entries(files)) out[p] = (await sha256Hex(s)).slice(0, 32)
  return out
}

/** Paths whose hash differs between two per-file hash maps, including added and removed files. */
export function changedPaths(a: Record<string, string>, b: Record<string, string>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((p) => a[p] !== b[p]).sort()
}

/**
 * Identity of a release for edits (code review 06 item 5): the original dynamic files plus everything else that
 * changes what they compile to (readonly sources, externals, aliases, Tailwind theme, compiler, CSS mode). A
 * snapshot made on another release is `stale`; when none of its files changed in the release it is carried over
 * (recompiled) by itself.
 */
export async function releaseHash(filesHash: string, ctxHash: string, cssMode: string): Promise<string> {
  return sha256Hex(JSON.stringify(['mk-release', 1, filesHash, ctxHash, COMPILER_VERSION, cssMode]))
}

/**
 * The release hash a browser running this build writes into its snapshots as `baseHash` (C10: `pleatkit
 * carry-over --release <hash>` computes it from the build's manifest, so carried-over snapshots are not stale).
 */
export async function manifestReleaseHash(m: PleatkitManifest): Promise<string> {
  const files = Object.fromEntries(m.dynamic.map((f) => [f.path, f.source]))
  const ctx = await contextHash(m, Object.fromEntries(m.readonly.map((f) => [f.path, f.source])))
  return releaseHash(await hashFiles(files), ctx, m.css?.mode === 'tailwind' ? 'tailwind' : 'palette')
}
