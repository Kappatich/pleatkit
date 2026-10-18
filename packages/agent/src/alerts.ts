import type { AgentResult } from '@pleatkit/runtime/compiler'
import type { Identity } from './auth.js'
import type { StoreClient } from './store-client.js'
import { pleatkitEnv } from '@pleatkit/runtime/env'

/**
 * Real-time alerts and automatic freezes (brainstorm 05 #5, 12 B7): nobody watches the dashboard on a Sunday
 * night, so the agent server says it: a webhook (Slack, PagerDuty, any JSON endpoint) and/or an e-mail API.
 *
 * - `static-rule`: an edit tried something the static rules refuse (a remote request, a cookie read...);
 * - `budget`: the app crossed 50 %, 80 % or 100 % of its daily dollar budget (once per threshold per day);
 * - `freeze`: one user looked like abuse (rule violations, a burst of requests, a large share of the app's
 *   budget) and was frozen alone (`edits.enabled: false` for that user), instead of the whole app running out;
 * - `digest`: the weekly digest (C5, `pleatkit digest --week --send`), its markdown in `details.markdown`.
 */
export type AlertKind = 'static-rule' | 'budget' | 'freeze' | 'digest'

export interface Alert {
  kind: AlertKind
  severity: 'info' | 'warning' | 'critical'
  appId: string
  userId?: string
  requestId?: string | null
  title: string
  details: Record<string, unknown>
  at: string
}

export interface AlertSink {
  send(alert: Alert): Promise<void>
}

/** POST the alert as JSON (`{ text, alert }`: Slack incoming webhooks read `text`). */
export class WebhookSink implements AlertSink {
  constructor(
    private readonly url: string,
    private readonly fetchFn: typeof fetch = (...a) => globalThis.fetch(...a),
  ) {}
  async send(alert: Alert): Promise<void> {
    const res = await this.fetchFn(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: alert.kind === 'digest' ? `${alert.title}\n\n${String(alert.details.markdown ?? '')}` : `[pleatkit ${alert.severity}] ${alert.title}`, alert }),
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) throw new Error(`alert webhook answered ${res.status}`)
  }
}

/**
 * E-mail through an HTTP e-mail API (Resend, Postmark, SES via a small relay...): POST `{ to, subject, text }` with
 * `Authorization: Bearer <token>`. No SMTP client in the agent server.
 */
export class EmailSink implements AlertSink {
  constructor(
    private readonly url: string,
    private readonly to: string,
    private readonly token: string | null,
    private readonly fetchFn: typeof fetch = (...a) => globalThis.fetch(...a),
  ) {}
  async send(alert: Alert): Promise<void> {
    const text =
      alert.kind === 'digest'
        ? String(alert.details.markdown ?? '')
        : [alert.title, '', ...Object.entries(alert.details).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`), '', `app ${alert.appId}${alert.userId ? `, user ${alert.userId}` : ''}, ${alert.at}`].join('\n')
    const res = await this.fetchFn(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ to: this.to, subject: alert.kind === 'digest' ? alert.title : `[pleatkit ${alert.severity}] ${alert.title}`, text }),
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) throw new Error(`alert e-mail API answered ${res.status}`)
  }
}

export interface FreezePolicy {
  /** Static-rule violations by one user within an hour that freeze them. Default 3. */
  violationsPerHour: number
  /** Requests by one user within a minute that freeze them. Default 12. */
  requestsPerMinute: number
  /** Share of the app's daily dollar budget one user may spend in a day. Default 0.3. */
  userShareOfAppBudget: number
}

export const DEFAULT_FREEZE: FreezePolicy = { violationsPerHour: 3, requestsPerMinute: 12, userShareOfAppBudget: 0.3 }
export const BUDGET_THRESHOLDS = [0.5, 0.8, 1] as const

/** What the quota backend knows after a run: the share of each daily dollar budget already used (0..1+). */
export interface BudgetUse {
  appUsd: number | null
  /** The user's spend today as a share of the app's daily budget (for the freeze rule). */
  userShareOfApp: number | null
}

export interface AlertsOptions {
  sinks: AlertSink[]
  freeze?: Partial<FreezePolicy> | false
  /** Freezes a user in store-server (flag `edits.enabled: false` at user scope); in memory without a store. */
  store?: StoreClient | null
  log?: (line: string) => void
  now?: () => number
}

/** Alerts, thresholds and freezes for one agent server process. */
export class Alerts {
  private readonly sent = new Set<string>()
  private readonly events = new Map<string, { requests: number[]; violations: number[] }>()
  /** Users frozen by this process (also written to store-server when there is one). */
  readonly frozen = new Set<string>()
  private readonly freezing = new Set<string>()
  private readonly policy: FreezePolicy | null
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(private readonly o: AlertsOptions) {
    this.policy = o.freeze === false ? null : { ...DEFAULT_FREEZE, ...o.freeze }
    this.now = o.now ?? Date.now
    this.log = o.log ?? ((l) => console.log(l))
  }

  isFrozen(who: Pick<Identity, 'appId' | 'userId'>): boolean {
    return this.frozen.has(`${who.appId}\0${who.userId}`)
  }

  private async emit(alert: Omit<Alert, 'at'>): Promise<void> {
    const full = { ...alert, at: new Date(this.now()).toISOString() }
    await Promise.all(
      this.o.sinks.map((s) =>
        s.send(full).catch((e: Error) => this.log(`[pleatkit-agent] could not send the ${alert.kind} alert: ${e.message}`)),
      ),
    )
  }

  /** Before a run: count it; a burst of requests freezes the user. Returns true when the user is frozen. */
  async beforeRun(who: Identity): Promise<boolean> {
    if (this.isFrozen(who)) return true
    const ev = this.track(who)
    const t = this.now()
    ev.requests = ev.requests.filter((x) => t - x < 60_000)
    ev.requests.push(t)
    if (this.policy && ev.requests.length > this.policy.requestsPerMinute) {
      await this.freeze(who, `${ev.requests.length} requests within a minute`, null)
      return true
    }
    return false
  }

  /** After a run: rule violations, budget thresholds, the user's share of the app's budget. */
  async afterRun(who: Identity, result: Pick<AgentResult, 'log' | 'verdict'> & { requestId?: string | null }, budget: BudgetUse | null): Promise<void> {
    const rules = [...new Set(result.log.flatMap((l) => (l.violation ? [l.violation] : [])))]
    if (rules.length) {
      await this.emit({
        kind: 'static-rule',
        severity: 'warning',
        appId: who.appId,
        userId: who.userId,
        requestId: result.requestId ?? null,
        title: `An edit for ${who.userId} broke a rule of the dynamic zone`,
        details: { violations: rules, verdict: result.verdict },
      })
      const ev = this.track(who)
      const t = this.now()
      ev.violations = ev.violations.filter((x) => t - x < 3_600_000)
      ev.violations.push(t)
      if (this.policy && ev.violations.length >= this.policy.violationsPerHour) {
        await this.freeze(who, `${ev.violations.length} rule violations within an hour`, result.requestId ?? null)
      }
    }
    if (budget?.appUsd !== null && budget?.appUsd !== undefined) {
      const day = new Date(this.now()).toISOString().slice(0, 10)
      for (const th of BUDGET_THRESHOLDS) {
        const key = `budget\0${who.appId}\0${th}\0${day}`
        if (budget.appUsd >= th && !this.sent.has(key)) {
          this.sent.add(key)
          await this.emit({
            kind: 'budget',
            severity: th >= 1 ? 'critical' : th >= 0.8 ? 'warning' : 'info',
            appId: who.appId,
            title: `The app used ${Math.round(th * 100)} % of today's model budget`,
            details: { used: Math.round(budget.appUsd * 1000) / 10 + ' %' },
          })
        }
      }
    }
    if (this.policy && budget?.userShareOfApp !== null && budget?.userShareOfApp !== undefined && budget.userShareOfApp > this.policy.userShareOfAppBudget) {
      await this.freeze(who, `spent ${Math.round(budget.userShareOfApp * 100)} % of the app's daily budget alone`, result.requestId ?? null)
    }
  }

  private track(who: Pick<Identity, 'appId' | 'userId'>) {
    const k = `${who.appId}\0${who.userId}`
    let ev = this.events.get(k)
    if (!ev) {
      ev = { requests: [], violations: [] }
      this.events.set(k, ev)
      if (this.events.size > 10_000) this.events.delete(this.events.keys().next().value!)
    }
    return ev
  }

  /** Freeze one user (not the app): their versions stay, new edits are refused until an admin lifts it. */
  async freeze(who: Pick<Identity, 'appId' | 'userId' | 'orgId' | 'environment'>, reason: string, requestId: string | null): Promise<void> {
    const k = `${who.appId}\0${who.userId}`
    if (this.frozen.has(k) || this.freezing.has(k)) return
    this.freezing.add(k)
    let stored = false
    if (this.o.store) {
      stored = await this.o.store
        .setUserFlag(who, 'edits.enabled', false)
        .then(() => true)
        .catch((e: Error) => (this.log(`[pleatkit-agent] could not freeze ${who.userId} in store-server: ${e.message}`), false))
    }
    // with a store the flag is the freeze (an admin lifts it there); without one this process remembers it
    if (!stored) this.frozen.add(k)
    this.freezing.delete(k)
    this.log(`[pleatkit-agent] ${who.appId}/${who.userId}: frozen (${reason})`)
    await this.emit({
      kind: 'freeze',
      severity: 'critical',
      appId: who.appId,
      userId: who.userId,
      requestId,
      title: `${who.userId} was frozen automatically: ${reason}`,
      details: { reason, where: stored ? 'store-server flag edits.enabled=false (user scope)' : 'this agent process', undo: 'PUT /v1/admin/flags { scope: "user", scopeId, key: "edits.enabled", value: null }' },
    })
  }
}

/** PLEATKIT_ALERT_WEBHOOK, PLEATKIT_ALERT_EMAIL_URL + _TO (+ _TOKEN), PLEATKIT_FREEZE ('off' or JSON policy). */
export function alertsFromEnv(env: Record<string, string | undefined>): Pick<AlertsOptions, 'sinks' | 'freeze'> {
  pleatkitEnv(env)
  const sinks: AlertSink[] = []
  if (env.PLEATKIT_ALERT_WEBHOOK) sinks.push(new WebhookSink(env.PLEATKIT_ALERT_WEBHOOK))
  if (env.PLEATKIT_ALERT_EMAIL_URL) {
    if (!env.PLEATKIT_ALERT_EMAIL_TO) throw new Error('PLEATKIT_ALERT_EMAIL_URL needs PLEATKIT_ALERT_EMAIL_TO')
    sinks.push(new EmailSink(env.PLEATKIT_ALERT_EMAIL_URL, env.PLEATKIT_ALERT_EMAIL_TO, env.PLEATKIT_ALERT_EMAIL_TOKEN ?? null))
  }
  let freeze: AlertsOptions['freeze']
  if (env.PLEATKIT_FREEZE === 'off') freeze = false
  else if (env.PLEATKIT_FREEZE) {
    try {
      freeze = JSON.parse(env.PLEATKIT_FREEZE) as Partial<FreezePolicy>
    } catch {
      throw new Error('PLEATKIT_FREEZE must be "off" or JSON like {"violationsPerHour": 3, "requestsPerMinute": 12, "userShareOfAppBudget": 0.3}')
    }
  }
  return { sinks, ...(freeze !== undefined ? { freeze } : {}) }
}
