/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect raw JSON wire payloads */
import { describe, expect, it } from 'vitest'
import { alertsFromEnv, EmailSink, sendAlert, WebhookSink, type Alert, type AlertSink } from '../src/alerts.js'

const drift = {
  kind: 'eval-drift' as const,
  severity: 'warning' as const,
  appId: 'pleatkit-evals',
  title: 'Weekly eval drift 2026-10-19: 1 set regressed',
  details: { text: 'regressed: awkward (aw-03)\ncost $0.14', report: 'evals/results/weekly-2026-10-19.json' },
}

describe('sendAlert: one alert outside the agent server (brainstorm 17 §20, eval:weekly)', () => {
  it('posts to every sink; the webhook and the e-mail carry details.text under the title', async () => {
    const posts: { url: string; body: any }[] = []
    const fake = (async (url: string, init?: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init?.body)) })
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const n = await sendAlert({ ...drift, at: '2026-10-19T06:00:00.000Z' }, [new WebhookSink('http://hook.test', fake), new EmailSink('http://mail.test', 'ops@example.com', null, fake)])
    expect(n).toBe(2)
    expect(posts[0]!.body.text).toBe('[pleatkit warning] Weekly eval drift 2026-10-19: 1 set regressed\nregressed: awkward (aw-03)\ncost $0.14')
    expect(posts[0]!.body.alert).toMatchObject({ kind: 'eval-drift', at: '2026-10-19T06:00:00.000Z' })
    expect(posts[1]!.body.subject).toBe('[pleatkit warning] Weekly eval drift 2026-10-19: 1 set regressed')
    expect(posts[1]!.body.text).toContain('regressed: awkward (aw-03)\ncost $0.14\n\nreport: evals/results/weekly-2026-10-19.json')
    expect(posts[1]!.body.text).not.toContain('text: ')
  })

  it('a failing sink is logged and skipped; the others still get the alert', async () => {
    const got: Alert[] = []
    const ok: AlertSink = { send: async (a) => void got.push(a) }
    const dead: AlertSink = { send: async () => Promise.reject(new Error('alert webhook answered 500')) }
    const lines: string[] = []
    expect(await sendAlert(drift, [dead, ok], (l) => lines.push(l))).toBe(1)
    expect(got[0]!.at).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(lines).toEqual(['[pleatkit] could not send the eval-drift alert: alert webhook answered 500'])
    expect(await sendAlert(drift, [])).toBe(0)
  })

  it('an alert without details.text is printed as before', async () => {
    const posts: any[] = []
    const fake = (async (_url: string, init?: RequestInit) => (posts.push(JSON.parse(String(init?.body))), new Response('{}'))) as typeof fetch
    await sendAlert({ kind: 'budget', severity: 'info', appId: 'crm', title: 'The app used 50 % of today\'s model budget', details: { used: '50 %' } }, [new WebhookSink('http://h.test', fake)])
    expect(posts[0].text).toBe("[pleatkit info] The app used 50 % of today's model budget")
  })

  it('the sinks come from the same variables as the agent server', () => {
    expect(alertsFromEnv({ PLEATKIT_ALERT_WEBHOOK: 'http://hook.test', PLEATKIT_ALERT_EMAIL_URL: 'http://mail.test', PLEATKIT_ALERT_EMAIL_TO: 'ops@example.com' }).sinks).toHaveLength(2)
    expect(alertsFromEnv({}).sinks).toHaveLength(0)
  })
})
