# Support playbook

For the person who answers the customer's tickets about pleatkit ("my screen looks different", "my change is gone",
"the panel is broken"). It covers what the roles may do, where to look, and the ten tickets we expect most.
Incidents (data leaving, a bot, an outage) are in [ops/incident.md](ops/incident.md).

## Roles (C8)

The customer's backend mints the user token (`mintUserToken`, HS256, at most 15 minutes) with one of two roles:

| Role | Can | Cannot |
|---|---|---|
| `user` | read and change their own version through the drawer | see anyone else's version or anything under `/admin` |
| `admin` | everything under `/v1/admin` (requests, labels, flags, events, audit, plan, settings, approve, reject, rollback, export, erasure) and every user's versions | — |

The app key (`mk_live_…`, server to server) is an admin of its app. Roles are enforced by store-server
(`packages/store-server/src/auth.ts`, `app.ts`). The open store knows only `user` and `admin`: a token with another
role (for example `support`), and any call with `x-pleatkit-act-as`, gets 403 with `code: 'cloud-feature'`.

**In the pleatkit cloud** (DECISIONS 89) there is a third role, `support`: it reads everything under `/admin` except
the export, changes nothing, and may "view as a user": open the app with that user's version of the panels (their
snapshot head and history), with every call, refused writes included, written to the audit chain with both ids. Only
an `admin` writes as a user. The cloud also has the screens this playbook mentions below as "cloud": the wish map,
release carry-over runs, and code search with rollback by selection.

What a version is: the user's **version of the panels** (their snapshot head and history in store-server). The
**data** in the panels always comes from the customer's backend for the viewer's own session; pleatkit never sees or
proxies the customer's business data.

## Before you answer: find the version

1. Ask for the **time of the change** (the drawer's history lists every version with its time). The version id is in `engine.diagnostics().shortId` and in the Sentry tag `pleatkit.snapshotId`; the drawer does not show it yet.
2. `/admin` → filter by the user, open the request: the summary, the diff against the previous version, the tool
   log behind "Technical details".
3. If the ticket says "it looks different from my colleague's": compare the two users' latest requests and their
   diffs (in the cloud: **View as** both users). A difference that is in the code is in the diff; a difference that
   is in the data is the customer's backend.

## The ten tickets

| Ticket | Check | Answer / action |
|---|---|---|
| "My screen looks different from yesterday" | The request log for the user; the diff of the latest edit | Tell them which request changed it; they undo it in the drawer (↶) or restore a version from the history |
| "My change is gone" | Is the version still the head? An admin rollback (in the cloud also a code-search or release rollback)? (`/admin?view=audit`, filter by the user) | Say who rolled it back and why (the audit row); the user restores it from the drawer's history, or an admin does it for them |
| "Delete my data" (a data subject request) | Which app and which user id; the request comes from the customer, not from the end user directly | Escalate to the customer's admin: `pleatkit erase --user <id> --app <app>` (two steps, a confirm token). Keep the tombstone id the command prints with the ticket ([security/retention.md](security/retention.md)) |
| "The panel shows 'the app was updated'" | The release changed a file the user had edited | They press "carry over" or "reset" in the banner (in the cloud the admin can also carry everyone over in one run) |
| "The panel is broken / blank" | Safe mode? The request's tool log and the browser console (`[pleatkit] …`) | `?pleatkit=safe` shows the original; the user undoes the edit; file a bug with `pleatkit report` |
| "It says 'Sent to the administrator'" | The request is `needs backend` (`pending-admin`) | The admin takes it into work or rejects it |
| "It refused my request" | Verdict `declined`, `not-editable`, `refused` (off-topic, quota, kill switch) | Explain which: outside the panels, not allowed, over today's limit, paused by the admin |
| "Can I have what Bob has?" | Bob's requests in the request log | Today each user asks for it themselves; organization-wide versions are on the roadmap (`scope: org`) |
| "I don't want any of this" | — | The user resets to the original in the drawer; an admin can turn edits off for that user (Flags → `edits.enabled` false) |
| "Is my data sent to an AI?" | — | Point to [security/data-flows.md](security/data-flows.md): the request text and the panel code go to the model provider; field values do not, unless the customer turned `sendDomText` on |
| "Something is wrong for everyone" | Status of store-server and the agent; recent alerts | Escalate to the on-duty person ([ops/incident.md](ops/incident.md)); do not use the kill switch yourself unless you are an admin |

## What support must not do

- Look at a user's version without a ticket that asks for it. The audit chain records admin actions (and, in the
  cloud, every "view as" call with both ids), and the customer can export it.
- Paste a user's code, request text or screenshots into a public issue. `pleatkit report` redacts secrets but not
  the customer's panel code; attach panel code only with the customer's consent.
- Share a token. It lives 15 minutes; ask the customer's backend for a new one.

## Escalation

| Level | Who | When |
|---|---|---|
| 1 | support (an `admin` of the app in the open core; the `support` role in the cloud) | tickets above |
| 2 | the customer's admin (`admin` role) | rollbacks, flags, plan, writes as a user, erasure |
| 3 | pleatkit on duty ([ops/incident.md](ops/incident.md)) | an incident, a bug in pleatkit, a vulnerability ([../SECURITY.md](../SECURITY.md)) |
