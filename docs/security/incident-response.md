> **Draft, for the lawyer.** Written from the code and the runbook as of stage 4c (2026-10-18); not reviewed by
> counsel. `[[...]]` marks what Minte fills in.

# Incident response policy

The policy: who decides, how fast, and what the customer hears. The technical steps (what to run, in which order)
are the runbook: [../ops/incident.md](../ops/incident.md). How support handles ordinary tickets:
[../support-playbook.md](../support-playbook.md).

## Scope

A security incident is any event where customer data (panel code, request text, the audit chain) was or may have
been read, changed or sent by someone who should not have; where an edit ran code the static rules should have
refused; or where pleatkit Cloud was unavailable long enough to block customers' edits.

## Roles

| Role | Who | Does |
|---|---|---|
| Incident lead | the person on duty ([[name/rotation]]) | decides containment, keeps the timeline, writes the post-mortem |
| Security contact | [[security@ address]] | receives reports ([../../SECURITY.md](../../SECURITY.md)), confirms within 24 hours |
| Customer contact | [[name]] | notifies affected customers, answers their questions |

Coding agents may read logs and draft; a human does mass rollbacks, data deletion and key rotation (DECISIONS 43,
brainstorm 12 B7).

## What the product does by itself

These run without a human, so the first minutes of an incident are covered at night:

- **Static rules** refuse edits that make network requests, read cookies or storage, change `location`, use computed
  URLs, `eval`, and other patterns (`packages/runtime/src/check.ts`); refused edits are never committed.
- **Signed bundles**: with a public key in the build, browsers run only bundles signed by the app key.
- **Automatic freeze** of one user after 3 rule violations in an hour, more than 12 requests in a minute, or more
  than 30 % of the app's daily budget spent alone (`edits.enabled: false` for that user).
- **Safe mode**: a version that did not mount is not loaded again; the user sees the original.
- **Alerts** to the operator's webhook or e-mail on rule violations, freezes and 50/80/100 % of the daily budget.

## Timeline

| When | What |
|---|---|
| 0 | Detection (alert, report, monitoring). The incident lead opens a timeline (time, who, what). |
| ≤ 1 hour (Cloud, business hours) / ≤ [[n]] hours (nights, weekends) | Containment: freeze the user, the organization or the app (kill switch); roll back what is live (one request, code search + rollback by selection, or a release rollback). Preserve evidence with `pleatkit export` before deleting anything. |
| ≤ 24 hours | Acknowledge a vulnerability report. First notice to affected customers when their data may be involved: what happened, what is contained, what they should do (for example rotate `PLEATKIT_JWT_SECRET`). |
| ≤ 72 hours | Notice to customers as their controller obligations require (GDPR art. 33 gives the controller 72 hours to notify the authority; pleatkit as processor notifies the controller "without undue delay") [[confirm wording with counsel]]. Post-mortem written. |
| After | Fix, a regression test (a rule bypass goes into `packages/runtime/test/check.test.ts`), release, and the post-mortem shared with affected customers. |

## Evidence

- The audit chain is append-only and hash-linked; `GET /v1/admin/audit?verify=1` (or /admin → Audit) shows whether
  it is intact. An impersonated read or write carries both ids.
- `pleatkit export` gives a complete JSON copy of an app or a user at the time of the incident.
- The request log keeps the tool log for 30 days and the request text for 90 days ([retention.md](retention.md)):
  export early when an incident may need them later.

## Notification template

> Subject: pleatkit security notice for {app}
>
> On {date} at {time UTC} we found {what happened}. It affected {which users / organizations / data}. We contained it
> at {time} by {action}. Your data {was / was not} {read / changed / sent} {details}. What you should do: {steps}.
> What we are changing: {fix}. We will send the full post-mortem by {date}. Contact: {name, address}.
