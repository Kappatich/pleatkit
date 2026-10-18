import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * F8: anonymous, opt-out telemetry of the install funnel (`plugin.build`, `doctor.run`, `doctor.fail:<check>`,
 * `ping.ok`, ...). Events only: a name, a few enum-like properties, the package version, the Node major and the
 * OS platform, and a random install id. Never code, file names, paths, URLs, keys or user data.
 *
 * Off when PLEATKIT_TELEMETRY=0 (or false/off), DO_NOT_TRACK=1, or in CI. It also stays off until a collector
 * exists: TELEMETRY_ENDPOINT is null in this version (PLEATKIT_TELEMETRY_URL sets one), and then nothing is sent
 * and no install id is written.
 */
export const TELEMETRY_ENDPOINT: string | null = null

type Env = Record<string, string | undefined>
export type TelemetryProps = Record<string, string | number | boolean>

export interface TelemetryOptions {
  env?: Env
  /** Where `.pleatkit/telemetry.json` (install id, notice shown) lives. Default: the user's home directory. */
  home?: string
  fetch?: typeof fetch
  /** Package and version that send the event. */
  source?: { package: string; version: string }
  /** Where the first-run notice goes. Default stderr. */
  notice?: (line: string) => void
}

export function telemetryStatus(env: Env = process.env): { enabled: boolean; reason: string; endpoint: string | null } {
  const endpoint = env.PLEATKIT_TELEMETRY_URL || TELEMETRY_ENDPOINT
  const off = (env.PLEATKIT_TELEMETRY ?? '').toLowerCase()
  if (['0', 'false', 'off', 'no'].includes(off)) return { enabled: false, reason: 'PLEATKIT_TELEMETRY=0', endpoint }
  if (env.DO_NOT_TRACK === '1' || env.DO_NOT_TRACK === 'true') return { enabled: false, reason: 'DO_NOT_TRACK', endpoint }
  if (env.CI && env.CI !== 'false' && env.CI !== '0') return { enabled: false, reason: 'CI', endpoint }
  if (!endpoint) return { enabled: false, reason: 'no collector configured', endpoint: null }
  return { enabled: true, reason: 'on', endpoint }
}

/** Only short, path-free values: anything that could carry a file name, a URL or code is dropped. */
export function sanitizeProps(props: TelemetryProps): TelemetryProps {
  const out: TelemetryProps = {}
  for (const [k, v] of Object.entries(props)) {
    if (!/^[a-zA-Z][\w.-]{0,40}$/.test(k)) continue
    if (typeof v === 'string' && (v.length > 40 || /[\\/:@\s]/.test(v))) continue
    if (typeof v === 'number' && !Number.isFinite(v)) continue
    out[k] = v
  }
  return out
}

interface State {
  installId: string
  noticeShown: boolean
}

function loadState(dir: string): State | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'telemetry.json'), 'utf8')) as State
  } catch {
    return null
  }
}

/** Send one event. Never throws, never waits longer than 1.5 s; resolves to whether it was sent. */
export async function track(event: string, props: TelemetryProps = {}, o: TelemetryOptions = {}): Promise<boolean> {
  try {
    const env = o.env ?? process.env
    const status = telemetryStatus(env)
    if (!status.enabled || !status.endpoint) return false
    if (!/^[a-z][\w.:-]{0,60}$/.test(event)) return false
    const dir = path.join(o.home ?? os.homedir(), '.pleatkit')
    let state = loadState(dir)
    if (!state) state = { installId: randomUUID(), noticeShown: false }
    if (!state.noticeShown) {
      ;(o.notice ?? ((l: string) => process.stderr.write(l + '\n')))(
        'pleatkit: anonymous install-funnel events are on (event names only: no code, no paths). Turn them off with PLEATKIT_TELEMETRY=0. See README, "Telemetry".',
      )
      state.noticeShown = true
    }
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'telemetry.json'), JSON.stringify(state))
    } catch {
      // read-only home: still anonymous, just not stable across runs
    }
    const body = {
      event,
      installId: state.installId,
      package: o.source?.package ?? 'pleatkit',
      version: o.source?.version ?? '0',
      node: Number(process.versions.node.split('.')[0]),
      os: process.platform,
      ts: new Date().toISOString(),
      props: sanitizeProps(props),
    }
    const f = o.fetch ?? globalThis.fetch
    const res = await f(status.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(1_500) })
    return res.ok
  } catch {
    return false
  }
}
