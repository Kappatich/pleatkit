# Support playbook

For the person who answers the customer's tickets about pleatkit ("my screen looks different", "my change is gone",
"the panel is broken"). It covers what the `support` role may do, how "view as a user" works and what it records,
and the ten tickets we expect most. Incidents (data leaving, a bot, an outage) are in [ops/incident.md](ops/incident.md).

## Roles (C8)

The customer's backend mints the user token (`mintUserToken`, HS256, at most 15 minutes) with one of three roles:

| Role | Can | Cannot |
|---|---|---|
| `user` | read and change their own version through the drawer | see anyone else's version or anything under `/admin` |
| `support` | read everything under `/v1/admin` (requests, stats, wishes, code search, releases, flags, events, audit, plan); view one user at a time ("view as"): read their version and history, every call audited | change anything under `/admin` (no approve, reject, rollback, flags, plan, settings, bulk operations, erasure); **write as a user** (restore a version, store a snapshot: 403 since 0.2, DECISIONS 70.5); export (`/v1/admin/export`); the pilot report (`/v1/report`) |
| `admin` | everything above, plus every write under `/admin`, writes as a user ("view as" with an admin token), the export, the report and erasure | — |

The app key (`mk_live_…`, server to server) is an admin of its app. Roles are enforced by store-server
(`packages/store-server/src/auth.ts`, `app.ts`); a token with any other role is refused (401).

## "View as a user" (impersonation)

What it is: support opens the app with the user's **version of the panels** (their snapshot head and history from
store-server). The **data** in the panels is the viewer's own: it comes from the customer's backend for the
viewer's session; pleatkit never sees or proxies the customer's business data. So support sees how the user's
panels are built (columns, fields, colours, layout) on the data support is allowed to see.

How it works:

- The browser sends `x-pleatkit-act-as: <user id>` with the support person's own token (`HttpStore({ userId:
  '<user>', viewer: '<support id>', token })`). store-server accepts it only for `support` and `admin` tokens;
  a `user` token with the header gets 403.
- **Support only reads.** Any write with the header and a `support` token (moving the head, storing a snapshot,
  logging a request) gets 403 `support-read-only`, and nothing changes. Only an `admin` token writes as a user.
- Every call made this way, reads and refused writes included, adds a row to the app's audit chain: action
  `impersonate.read` or `impersonate.write`, actor `<role>:<viewer>:as:<user>`, details
  `{ viewer, user, role, method, path, status }` (a refused write has `status: 403`). An admin's write also keeps its
  own audit row (`head.set`, `snapshot.create`) with the same two-id actor. The chain is hash-linked;
  `/admin?view=audit` shows these rows with an "as" mark and verifies the chain.
- In the demo: `/admin` → open a request → **View as {user}** opens `/?user=<user>&as=support`: a black banner
  "Viewing as {user}", the user's panels, no chat. **Exit** goes back to /admin.
- The chat is not shown in the support view on purpose: support does not make edits in the user's name, and
  store-server refuses support's writes as a user anyway. To undo something for the user, ask an admin (**Undo for
  {user}**, or "view as" with an admin token) or ask the user to press undo or restore the version in the drawer.

## Before you answer: find the version

1. Ask for the **time of the change** (the drawer's history lists every version with its time). The version id is in `engine.diagnostics().shortId` and in the Sentry tag `pleatkit.snapshotId`; the drawer does not show it yet.
2. `/admin` → filter by the user, open the request: the summary, the diff against the previous version, the tool
   log behind "Technical details".
3. If the ticket says "it looks different from my colleague's": **View as** both users. A difference that is in
   the code is in the diff; a difference that is in the data is the customer's backend.

## The ten tickets

| Ticket | Check | Answer / action |
|---|---|---|
| "My screen looks different from yesterday" | The request log for the user; the diff of the latest edit | Tell them which request changed it; they undo it in the drawer (↶) or restore a version from the history |
| "My change is gone" | Is the version still the head? An admin rollback, a code-search rollback, a release rollback? (`/admin?view=audit`, filter by the user) | Say who rolled it back and why (the audit row); the user restores it from the drawer's history, or an admin does it for them |
| "Delete my data" (a data subject request) | Which app and which user id; the request comes from the customer, not from the end user directly | Escalate to the customer's admin: `pleatkit erase --user <id> --app <app>` (two steps, a confirm token); support cannot erase. Keep the tombstone id the command prints with the ticket ([security/retention.md](security/retention.md)) |
| "The panel shows 'the app was updated'" | `/admin?view=releases`: was the user carried over, `stale`, `budget`? | They press "carry over" or "reset" in the banner; or the admin resumes `pleatkit carry-over` with more budget |
| "The panel is broken / blank" | Safe mode? The request's tool log and the browser console (`[pleatkit] …`) | `?pleatkit=safe` shows the original; the user undoes the edit; file a bug with `pleatkit report` |
| "It says 'Sent to the administrator'" | The request is `needs backend` (`pending-admin`) | The admin takes it into work or rejects it; it is on the Wishes screen too |
| "It refused my request" | Verdict `declined`, `not-editable`, `refused` (off-topic, quota, kill switch) | Explain which: outside the panels, not allowed, over today's limit, paused by the admin |
| "Can I have what Bob has?" | View as Bob | Today each user asks for it themselves; organization-wide versions are on the roadmap (`scope: org`) |
| "I don't want any of this" | — | The user resets to the original in the drawer; an admin can turn edits off for that user (Flags → `edits.enabled` false) |
| "Is my data sent to an AI?" | — | Point to [security/data-flows.md](security/data-flows.md): the request text and the panel code go to the model provider; field values do not, unless the customer turned `sendDomText` on |
| "Something is wrong for everyone" | Status of store-server and the agent; recent alerts | Escalate to the on-duty person ([ops/incident.md](ops/incident.md)); do not use the kill switch yourself unless you are an admin |

## What support must not do

- Act as a user without a ticket that asks for it. The audit chain shows every call with both ids, and the customer
  can export it.
- Paste a user's code, request text or screenshots into a public issue. `pleatkit report` redacts secrets but not
  the customer's panel code; attach panel code only with the customer's consent.
- Share a support token. It lives 15 minutes; ask the customer's backend for a new one.

## Escalation

| Level | Who | When |
|---|---|---|
| 1 | support (`support` role) | tickets above |
| 2 | the customer's admin (`admin` role) | rollbacks, flags, plan, releases, writes as a user, erasure |
| 3 | pleatkit on duty ([ops/incident.md](ops/incident.md)) | an incident, a bug in pleatkit, a vulnerability ([../SECURITY.md](../SECURITY.md)) |
