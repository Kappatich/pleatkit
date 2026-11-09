import fs from 'node:fs'
import path from 'node:path'
import { today } from './budget.js'
import type { RecentRequest } from './visitors.js'

/**
 * The demo's research log (docs/demo-hosting.md, "What is logged"): append-only JSONL under the data dir, one file
 * per UTC day (`events-YYYY-MM-DD.jsonl`), deleted after the retention period. Records carry the visitor's cookie
 * hash, never an IP address. Leads go to `leads.jsonl`. Nothing is sent anywhere: the coordinator pulls the files.
 */
export type Outcome =
  | 'applied'
  | 'refused_out_of_scope'
  | 'needs_backend'
  | 'compile_error'
  | 'runtime_error'
  | 'timeout'
  | 'cap_reached'
  | 'refused_offtopic'
  // outside the brief's list, so a record is never forced into a wrong bucket
  | 'clarify'
  | 'restore'
  | 'failed'

export const OUTCOMES: readonly Outcome[] = ['applied', 'refused_out_of_scope', 'needs_backend', 'compile_error', 'runtime_error', 'timeout', 'cap_reached', 'refused_offtopic', 'clarify', 'restore', 'failed']

export class DataLog {
  constructor(
    private readonly dir: string,
    private readonly retentionDays: number,
    private readonly log: (line: string) => void = (l) => console.log(l),
  ) {
    fs.mkdirSync(dir, { recursive: true })
  }

  private append(file: string, record: Record<string, unknown>): void {
    try {
      fs.appendFileSync(path.join(this.dir, file), JSON.stringify(record) + '\n')
    } catch (e) {
      this.log(`[demo] could not write ${file}: ${(e as Error).message}`)
    }
  }

  /** One record of kind `request`, `session`, `feedback` or `outcome` in today's file. */
  write(kind: 'request' | 'session' | 'feedback' | 'outcome', record: Record<string, unknown>): void {
    this.append(`events-${today()}.jsonl`, { kind, ts: new Date().toISOString(), ...record })
  }

  lead(record: Record<string, unknown>): void {
    this.append('leads.jsonl', { ts: new Date().toISOString(), ...record })
  }

  /** Delete event and stats files older than the retention period. */
  prune(now = Date.now()): number {
    const cutoff = today(now - this.retentionDays * 86_400_000)
    let n = 0
    for (const f of fs.readdirSync(this.dir)) {
      const m = /^(?:events|stats)-(\d{4}-\d{2}-\d{2})\.jsonl?$/.exec(f)
      if (m && m[1]! < cutoff) {
        fs.rmSync(path.join(this.dir, f), { force: true })
        n++
      }
    }
    return n
  }
}

/** Lower-case words of two or more letters or digits. */
export function wordsOf(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])
}

/**
 * Derived events of a new request against the visitor's earlier ones: `repeat` (the same text again) and
 * `rephrase` (free text within 90 s of the previous free-text request, sharing at least half of its words).
 */
export function derivedEvents(recent: readonly RecentRequest[], next: RecentRequest): { type: 'repeat' | 'rephrase'; sinceMs: number; overlap?: number }[] {
  const out: { type: 'repeat' | 'rephrase'; sinceMs: number; overlap?: number }[] = []
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim()
  const same = [...recent].reverse().find((r) => norm(r.text) === norm(next.text))
  if (same) out.push({ type: 'repeat', sinceMs: next.at - same.at })
  const prev = [...recent].reverse().find((r) => !r.chip)
  if (!next.chip && prev && !same && next.at - prev.at <= 90_000 && prev.words.size > 0) {
    let shared = 0
    for (const w of prev.words) if (next.words.has(w)) shared++
    const overlap = shared / prev.words.size
    if (overlap >= 0.5) out.push({ type: 'rephrase', sinceMs: next.at - prev.at, overlap: Math.round(overlap * 100) / 100 })
  }
  return out
}
