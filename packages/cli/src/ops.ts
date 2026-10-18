import fs from 'node:fs'
import path from 'node:path'
import type { PleatkitManifest } from '@pleatkit/vite-plugin'

/**
 * Operator commands that need the agent package (loaded only for them, like check-snapshots):
 * `pleatkit digest --week` (C5 + the C9 wish map) and `pleatkit carry-over --release <hash>` (C10).
 */
type Agent = typeof import('@pleatkit/agent')

async function loadAgent(): Promise<Agent | null> {
  return (await import('@pleatkit/agent').catch(() => null)) as Agent | null
}

const NEEDS_AGENT = (cmd: string) => `${cmd} needs @pleatkit/agent: pnpm add -D @pleatkit/agent`

export interface DigestArgs {
  store: string
  app: string
  key?: string
  days?: number
  out?: string
  /** Send through PLEATKIT_ALERT_WEBHOOK / PLEATKIT_ALERT_EMAIL_* (the alert channel). */
  send?: boolean
  /** Skip the classifier call; show the latest stored wish map. */
  noWishes?: boolean
  /** Panel ids for the wish map, from the build manifest when it exists. */
  manifest?: string
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
  cwd?: string
}

export async function digestCommand(a: DigestArgs): Promise<{ ok: boolean; lines: string[]; markdown?: string }> {
  const agent = await loadAgent()
  if (!agent) return { ok: false, lines: [NEEDS_AGENT('digest')] }
  const env = a.env ?? process.env
  let provider = null
  if (!a.noWishes) {
    try {
      provider = agent.providerFromEnv(env)
    } catch (e) {
      return { ok: false, lines: [`the wish map needs a model provider: ${(e as Error).message} (or pass --no-wishes)`] }
    }
  }
  let panels: string[] = []
  const manifestFile = a.manifest ? path.resolve(a.cwd ?? process.cwd(), a.manifest) : null
  if (manifestFile && fs.existsSync(manifestFile)) {
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as PleatkitManifest
    panels = agent.manifestPanels(m).map((p) => p.replace(/^.*\//, '').replace(/\.(tsx|ts|jsx|js)$/, ''))
  }
  let d
  try {
    d = await agent.buildDigest({ storeUrl: a.store, appId: a.app, appKey: a.key ?? null, provider, panels, days: a.days ?? 7, ...(a.fetch ? { fetch: a.fetch } : {}) })
  } catch (e) {
    return { ok: false, lines: [(e as Error).message, ...(/401/.test((e as Error).message) ? ['set PLEATKIT_APP_KEY (or pass --key) for a production store'] : [])] }
  }
  const markdown = agent.digestMarkdown(d)
  const lines: string[] = []
  if (a.out) {
    const file = path.resolve(a.cwd ?? process.cwd(), a.out)
    fs.writeFileSync(file, markdown)
    lines.push(`digest of ${a.app}, ${d.from.slice(0, 10)} to ${d.to.slice(0, 10)} -> ${file}`)
  } else lines.push(markdown)
  if (a.send) {
    const { sinks } = agent.alertsFromEnv(env)
    if (!sinks.length) return { ok: false, markdown, lines: [...lines, 'nothing to send to: set PLEATKIT_ALERT_WEBHOOK and/or PLEATKIT_ALERT_EMAIL_URL + PLEATKIT_ALERT_EMAIL_TO'] }
    try {
      lines.push(`sent to ${await agent.sendDigest(d, markdown, sinks)} channel(s)`)
    } catch (e) {
      return { ok: false, markdown, lines: [...lines, `could not send the digest: ${(e as Error).message}`] }
    }
  }
  return { ok: true, lines, markdown }
}

export interface CarryOverArgs {
  store: string
  app: string
  key?: string
  release: string
  budgetUsd: number
  manifest: string
  perUserUsd?: number
  dryRun?: boolean
  retry?: boolean
  rollback?: boolean
  typecheck?: boolean
  root?: string
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
}

export async function carryOverCommand(a: CarryOverArgs): Promise<{ ok: boolean; lines: string[] }> {
  const agent = await loadAgent()
  if (!agent) return { ok: false, lines: [NEEDS_AGENT('carry-over')] }
  if (a.rollback) {
    try {
      const r = await agent.rollbackRelease({ storeUrl: a.store, appId: a.app, appKey: a.key ?? null, release: a.release, ...(a.fetch ? { fetch: a.fetch } : {}) })
      return {
        ok: true,
        lines: [`release ${a.release} rolled back: ${r.restored.length} user(s) back on their previous version`, ...(r.kept.length ? [`${r.kept.length} user(s) edited again since and keep their newer version: ${r.kept.join(', ')}`] : [])],
      }
    } catch (e) {
      return { ok: false, lines: [(e as Error).message] }
    }
  }
  if (!fs.existsSync(a.manifest)) return { ok: false, lines: [`no manifest at ${a.manifest}: build the release first (vite build)`] }
  const manifest = JSON.parse(fs.readFileSync(a.manifest, 'utf8')) as PleatkitManifest
  const env = a.env ?? process.env
  let provider
  try {
    provider = agent.providerFromEnv(env)
  } catch (e) {
    return { ok: false, lines: [`carry-over needs a model provider for the edits it cannot carry by itself: ${(e as Error).message}`] }
  }
  const typecheck = a.typecheck ? agent.createTypechecker({ root: a.root ?? null }) : null
  const lines: string[] = []
  let r
  try {
    r = await agent.carryOverRelease({
      storeUrl: a.store,
      appId: a.app,
      appKey: a.key ?? null,
      manifest,
      release: a.release,
      budgetUsd: a.budgetUsd,
      provider,
      typecheck,
      ...(a.perUserUsd !== undefined ? { perUserUsd: a.perUserUsd } : {}),
      ...(a.dryRun ? { dryRun: true } : {}),
      ...(a.retry ? { retry: true } : {}),
      ...(a.fetch ? { fetch: a.fetch } : {}),
      log: (l) => lines.push(`  ${l}`),
    })
  } catch (e) {
    return { ok: false, lines: [...lines, (e as Error).message] }
  }
  const counts = Object.entries(r.counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ')
  const head = `${r.status === 'dry-run' ? 'dry run: ' : ''}release ${r.release}: ${counts || 'nothing to do'}${r.skipped ? ` (${r.skipped} done earlier)` : ''}; spent $${r.spentUsd.toFixed(4)} of $${r.budgetUsd.toFixed(2)}`
  const tail =
    r.status === 'budget'
      ? `stopped at the budget: run the same command with a higher --budget-usd to carry over the rest (users marked "budget")`
      : r.counts.stale
        ? `${r.counts.stale} user(s) keep their version and see "the app was updated" until they reset or ask the agent; --retry tries them again`
        : r.status === 'dry-run'
          ? 'nothing was written'
          : 'done; undo with --rollback'
  return { ok: true, lines: [head, ...lines, tail] }
}
