import fs from 'node:fs'
import path from 'node:path'
import type { DemoConfig } from './config.js'

/** UTC day, yyyy-mm-dd. */
export const today = (now = Date.now()): string => new Date(now).toISOString().slice(0, 10)

/** What the day's counters hold; written to stats-YYYY-MM-DD.json so a restart (a deploy) keeps the cap. No ids, no IPs. */
export interface DayStats {
  day: string
  /** Requests answered from the recorded fixtures (the six examples). */
  scripted: number
  /** Requests that went to the model. */
  live: number
  /** Free text refused because the demo runs SCRIPTED. */
  refused: number
  /** Free text refused because the day's live budget (or the visitor's share) was used up: demand beyond the cap. */
  capped: number
  /** Model spend so far, USD. */
  spentUsd: number
  warned80: boolean
}

export type LiveDecision = { ok: true } | { ok: false; why: 'off' | 'daily-usd' | 'daily-requests' | 'visitor' | 'busy' }

/**
 * The LIVE budget: a hard daily dollar cap and request cap for everyone together, a per-visitor cap counted by
 * cookie and by IP hash (in memory only, gone at midnight UTC or on restart), and a limit on runs at a time. A run
 * reserves its worst case (`perRequestUsd`) while it runs, so parallel runs cannot overshoot the cap by more than
 * the in-flight reservations allow.
 */
export class Budget {
  private stats: DayStats
  private readonly perKey = new Map<string, number>()
  private inFlight = 0
  private reservedUsd = 0

  constructor(
    private readonly config: Pick<DemoConfig, 'mode' | 'budget' | 'dataDir'>,
    private readonly log: (line: string) => void = (l) => console.log(l),
  ) {
    this.stats = this.load(today())
  }

  private file(day: string): string {
    return path.join(this.config.dataDir, `stats-${day}.json`)
  }

  private load(day: string): DayStats {
    try {
      const s = JSON.parse(fs.readFileSync(this.file(day), 'utf8')) as DayStats
      if (s.day === day) return s
    } catch {
      // a new day
    }
    return { day, scripted: 0, live: 0, refused: 0, capped: 0, spentUsd: 0, warned80: false }
  }

  private roll(): DayStats {
    const d = today()
    if (this.stats.day !== d) {
      this.stats = this.load(d)
      this.perKey.clear()
    }
    return this.stats
  }

  private save(): void {
    try {
      fs.mkdirSync(this.config.dataDir, { recursive: true })
      fs.writeFileSync(this.file(this.stats.day), JSON.stringify(this.stats, null, 2) + '\n')
    } catch (e) {
      this.log(`[demo] could not write the day's stats: ${(e as Error).message}`)
    }
  }

  get liveEnabled(): boolean {
    return this.config.mode === 'live'
  }

  /** Live requests this visitor may still send today (0 in SCRIPTED mode or when a cap is reached). */
  left(visitorKey: string, ipKey: string): number {
    if (!this.liveEnabled) return 0
    const s = this.roll()
    const b = this.config.budget
    if (s.spentUsd + this.reservedUsd + b.perRequestUsd > b.dailyUsd + 1e-9) return 0
    return Math.max(0, Math.min(this.visitorLeft(visitorKey, ipKey), b.dailyRequests - s.live - this.inFlight))
  }

  /** The visitor's own share: by cookie, and by IP hash with room for a few visitors behind one address. */
  private visitorLeft(visitorKey: string, ipKey: string): number {
    const b = this.config.budget
    const byCookie = b.perVisitor - (this.perKey.get(`v:${visitorKey}`) ?? 0)
    const byIp = b.perVisitor * b.perIpFactor - (this.perKey.get(`ip:${ipKey}`) ?? 0)
    return Math.min(byCookie, byIp)
  }

  /** Try to start one live run for this visitor; on success the caller must call `finish` exactly once. */
  begin(visitorKey: string, ipKey: string): LiveDecision {
    if (!this.liveEnabled) return { ok: false, why: 'off' }
    const s = this.roll()
    const b = this.config.budget
    // hard cap: a run starts only if its worst case still fits under the day's cap
    if (s.spentUsd + this.reservedUsd + b.perRequestUsd > b.dailyUsd + 1e-9) return { ok: false, why: 'daily-usd' }
    if (s.live + this.inFlight >= b.dailyRequests) return { ok: false, why: 'daily-requests' }
    if (this.visitorLeft(visitorKey, ipKey) <= 0) return { ok: false, why: 'visitor' }
    if (this.inFlight >= b.concurrency) return { ok: false, why: 'busy' }
    this.inFlight++
    this.reservedUsd += b.perRequestUsd
    this.perKey.set(`v:${visitorKey}`, (this.perKey.get(`v:${visitorKey}`) ?? 0) + 1)
    this.perKey.set(`ip:${ipKey}`, (this.perKey.get(`ip:${ipKey}`) ?? 0) + 1)
    return { ok: true }
  }

  /** A live run ended (or failed) with this cost. */
  finish(costUsd: number): void {
    const s = this.roll()
    const b = this.config.budget
    this.inFlight = Math.max(0, this.inFlight - 1)
    this.reservedUsd = Math.max(0, this.reservedUsd - b.perRequestUsd)
    s.live++
    s.spentUsd = Math.round((s.spentUsd + Math.max(0, costUsd)) * 1e6) / 1e6
    if (!s.warned80 && s.spentUsd >= b.dailyUsd * 0.8) {
      s.warned80 = true
      this.log(`[demo] WARNING: ${Math.round((s.spentUsd / b.dailyUsd) * 100)} % of today's live budget used ($${s.spentUsd.toFixed(2)} of $${b.dailyUsd.toFixed(2)}); at 100 % free text falls back to the scripted answers`)
    }
    if (s.spentUsd + b.perRequestUsd > b.dailyUsd + 1e-9) this.log(`[demo] today's live budget is used up ($${s.spentUsd.toFixed(2)}): free text now gets the scripted fallback until midnight UTC`)
    this.save()
  }

  count(what: 'scripted' | 'refused' | 'capped'): void {
    this.roll()[what]++
    this.save()
  }

  snapshot(): DayStats & { inFlight: number } {
    return { ...this.roll(), inFlight: this.inFlight }
  }
}
