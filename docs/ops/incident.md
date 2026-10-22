# Incident runbook

For whoever is on duty (DECISIONS 43, brainstorm 12 B7). No 24/7 pager: at night the automation acts (kill switch, safe mode, automatic freeze of one user); a human is woken only when the store is down for more than 10 minutes, the daily budget hits 100 %, or someone reports a vulnerability. An agent may read logs and draft; a human does mass rollbacks, data deletion and key rotation. Post-mortem within 72 hours.

## Where signals come from

| Signal | Source | Severity |
|---|---|---|
| `static-rule` alert | agent server: an edit tried something the rules refuse (remote request, cookie, `location`, storage...) | warning |
| `freeze` alert | agent server froze one user: 3 rule violations in an hour, more than 12 requests in a minute, or more than 30 % of the app's daily budget spent alone (`PLEATKIT_FREEZE`) | critical |
| `budget` alert | the app crossed 50 % (info), 80 % (warning), 100 % (critical) of its daily model budget | as listed |
| store-server down | health check `GET /health` from your monitoring; users see the original version (`offline`) within 5 s | critical after 10 min |
| crash reports | `pleatkit.snapshotId` / `pleatkit.bundle` tags in Sentry (`engine.tags()`) | depends |

Alerts go to `PLEATKIT_ALERT_WEBHOOK` (JSON POST, Slack-compatible `text`) and/or an e-mail API (`PLEATKIT_ALERT_EMAIL_URL`, `_TO`, `_TOKEN`). Without them, alerts only reach the agent server's log.

## First 15 minutes

1. **Scope.** Which app, which users, since when. `GET /v1/admin/events?type=edit.applied&since=<ms>`, `GET /v1/admin/requests?limit=200`, the alert's `requestId`.
2. **Contain.**
   - One user: freeze them (the automation may have done it already):
     `PUT /v1/admin/flags {"scope":"user","scopeId":"<user>","key":"edits.enabled","value":false}`. Their current version stays; new edits are refused.
   - One organization: the same with `"scope":"org"`.
   - The whole app (data leaving, a rule bypass in the wild): kill switch `PUT /v1/admin/flags {"scope":"app","key":"pleatkit.enabled","value":false}`. Everyone sees the original version on the next load; the agent refuses at once (flags are cached 15 s).
3. **Roll back** what is live and harmful: `POST /v1/admin/requests/<id>/rollback` per request, or the dashboard's button. A user's own edits after it must be rolled back first (newest first).
4. **Preserve evidence.** `pleatkit export --store <url> --app <id> --user <user> --out incident-<date>.json` before anything is deleted. The audit chain is append-only; check it with `GET /v1/admin/audit?verify=1`.

## Playbooks

**A rule bypass (data could leave the browser).** Kill switch for the app. Find every live version with the pattern: in the pleatkit cloud, /admin → Code search (`GET /v1/admin/snapshots?grep=<text>`, `&scope=all` for every version), then **Roll back N live versions** (`POST /v1/admin/snapshots/rollback {"grep": "<text>", "confirm": N}`): each user goes to their nearest earlier version without it, the rest of their edits stay. Self-hosted: `pleatkit export --app <id>` and search the snapshots' files, then roll back each matching request from /admin. Add the bypass to the static-check corpus (`packages/runtime/test/check.test.ts`) and fix the rule; the CSP (`img-src 'self'; form-action 'self'; connect-src 'self'`) should have blocked the request, so check the customer's CSP too. Lift the kill switch only after the fix is deployed to the agent server.

**A bot with valid tokens burning the budget.** The freeze stops one user at a time; if many users are involved (stolen tokens, a script), lower the app's plan (`PUT /v1/admin/plan`), ask the customer to rotate their JWT secret (`PLEATKIT_JWT_SECRET`), which invalidates every token within 15 minutes.

**store-server down.** Users keep working with the original version (the runtime falls back within 5 s); nothing to do in the browser. Restore the database from the last backup if needed; heads and snapshots are insert-only, so a partial restore never mixes versions. After recovery users get their versions on the next page load or focus (`refresh()`).

**Agent server down or the model provider failing.** The chat answers "something went wrong"; nobody loses a version. Check the provider status page; switch `PLEATKIT_PROVIDER` or `PLEATKIT_MODEL` only with an eval report (DECISIONS 43).

**A release broke personal versions.** Before the next release run `pleatkit check-snapshots --store <url> --app <id> --manifest dist/pleatkit.manifest.json --typecheck`. After it, each user's runtime carries their edits over on the next load where the release did not touch their files; the rest see "the app was updated" and reset or ask the agent. In the pleatkit cloud, `pleatkit-ops carry-over --release <hash> --budget-usd <n>` carries every user over in one run (no model where the release did not touch their files, the agent where it did, never past the budget; run it again to continue), and `pleatkit-ops carry-over --release <hash> --rollback` (or /admin → Releases → Roll back release) puts every user back on their version from before the run.

**Vulnerability report.** Acknowledge within 24 hours, do not discuss publicly, reproduce with a test, fix, release, credit the reporter if they agree.

## Lifting a freeze

`PUT /v1/admin/flags {"scope":"user","scopeId":"<user>","key":"edits.enabled","value":null}` removes the override. The agent reads flags with a 15 s cache. Without store-server the freeze lives only in the agent process: restart it to lift.

## After

Post-mortem within 72 hours: timeline, impact (users, data, money), what the automation did, what a human did, what changes (a test, a rule, an alert threshold). Notify the customer with what happened, what data was involved, what was done.
