import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Settings of the public demo server (docs/demo-hosting.md), from the environment only. The model key is read only
 * in LIVE mode and only by `providerFromEnv` (PLEATKIT_API_KEY or ANTHROPIC_API_KEY); it is never logged or sent to
 * the browser.
 */
export interface DemoConfig {
  /** `scripted` (default, zero model cost) or `live` (free text goes to the real agent within the budget). */
  mode: 'scripted' | 'live'
  /** LIVE only: `anthropic` (default) or `fake` (a local stand-in with made-up costs, for tests without a key). */
  liveProvider: 'anthropic' | 'fake'
  host: string
  port: number
  /** The built app (`vite build`): index.html, assets/, pleatkit.manifest.json. */
  webDir: string
  /** Recorded agent answers (e2e/fixtures/agent): the six demo requests are answered from here. */
  fixturesDir: string
  /** Per-visitor sandboxes (one SQLite store per visitor); wiped at start, each visitor's folder deleted after `visitorTtlMs`. */
  stateDir: string
  /** Append-only logs the coordinator reads: events-YYYY-MM-DD.jsonl, leads.jsonl, stats-YYYY-MM-DD.json. */
  dataDir: string
  /** Pause before each scripted step, so a recorded answer arrives at a realistic pace. */
  scriptedDelayMs: number
  budget: {
    /** Hard daily cap on model spend (UTC day); at 100 % free text falls back to SCRIPTED behaviour. */
    dailyUsd: number
    /** Daily cap on the number of live requests, all visitors together. */
    dailyRequests: number
    /** Live requests per visitor per day, counted by cookie (and by IP hash, see perIpFactor). */
    perVisitor: number
    /** The per-visitor cap times this is the cap per IP hash (several visitors behind one office address). */
    perIpFactor: number
    /** Ceiling of one live request (the agent stops the run when it reaches it). */
    perRequestUsd: number
    /** Live runs at a time. */
    concurrency: number
  }
  visitorTtlMs: number
  maxVisitors: number
  /** Days the JSONL logs are kept (leads.jsonl is kept until the coordinator removes it). */
  retentionDays: number
  /** `Secure` on the visitor cookie (on by default with NODE_ENV=production). */
  secureCookie: boolean
  /** Read the client address from `X-Demo-Client-IP` (set by nginx); only the rate limiter uses it, hashed. */
  trustProxy: boolean
  contactEmail: string
  siteUrl: string
  filmUrl: string
}

type Env = Record<string, string | undefined>

const here = path.dirname(fileURLToPath(import.meta.url))
/** apps/demo-crm when run from source; the release folder when bundled (server.mjs sits next to web/ and fixtures/). */
const appRoot = path.basename(here) === 'public' && path.basename(path.dirname(here)) === 'server' ? path.resolve(here, '..', '..') : here

const num = (v: string | undefined, fallback: number): number => (v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback)
const flag = (v: string | undefined, fallback: boolean): boolean => (v === undefined || v.trim() === '' ? fallback : ['1', 'true', 'on', 'yes'].includes(v.trim().toLowerCase()))

export function demoConfigFromEnv(env: Env = process.env): DemoConfig {
  const mode = (env.DEMO_MODE ?? 'scripted').trim().toLowerCase()
  if (mode !== 'scripted' && mode !== 'live') throw new Error(`DEMO_MODE must be scripted or live (got "${env.DEMO_MODE}")`)
  const liveProvider = (env.DEMO_LIVE_PROVIDER ?? 'anthropic').trim().toLowerCase()
  if (liveProvider !== 'anthropic' && liveProvider !== 'fake') throw new Error(`DEMO_LIVE_PROVIDER must be anthropic or fake (got "${env.DEMO_LIVE_PROVIDER}")`)
  const bundled = appRoot === here
  const tmp = path.join(os.tmpdir(), 'pleatkit-demo')
  return {
    mode,
    liveProvider,
    host: env.DEMO_HOST ?? '127.0.0.1',
    port: num(env.DEMO_PORT, 8710),
    webDir: path.resolve(env.DEMO_WEB_DIR ?? path.join(appRoot, bundled ? 'web' : 'dist')),
    fixturesDir: path.resolve(env.DEMO_FIXTURES ?? path.join(appRoot, bundled ? 'fixtures/agent' : 'e2e/fixtures/agent')),
    stateDir: path.resolve(env.DEMO_STATE_DIR ?? path.join(tmp, 'state')),
    dataDir: path.resolve(env.DEMO_DATA_DIR ?? path.join(tmp, 'data')),
    scriptedDelayMs: num(env.DEMO_SCRIPTED_DELAY_MS, 900),
    budget: {
      dailyUsd: num(env.DEMO_DAILY_USD, 5),
      dailyRequests: num(env.DEMO_DAILY_LIVE_REQUESTS, 100),
      perVisitor: num(env.DEMO_VISITOR_LIVE_REQUESTS, 5),
      perIpFactor: Math.max(1, num(env.DEMO_VISITOR_IP_FACTOR, 3)),
      perRequestUsd: num(env.DEMO_LIVE_MAX_USD_PER_REQUEST, 0.4),
      concurrency: Math.max(1, num(env.DEMO_LIVE_CONCURRENCY, 2)),
    },
    visitorTtlMs: num(env.DEMO_VISITOR_TTL_HOURS, 24) * 3_600_000,
    maxVisitors: num(env.DEMO_MAX_VISITORS, 2000),
    retentionDays: num(env.DEMO_RETENTION_DAYS, 30),
    secureCookie: flag(env.DEMO_SECURE_COOKIE, env.NODE_ENV === 'production'),
    trustProxy: flag(env.DEMO_TRUST_PROXY, false),
    contactEmail: env.DEMO_CONTACT_EMAIL ?? 'pilot@pleatkit.com',
    siteUrl: env.DEMO_SITE_URL ?? 'https://pleatkit.com',
    filmUrl: env.DEMO_FILM_URL ?? 'https://pleatkit.com/#demo',
  }
}
