> **Draft, for the lawyer.** Written from the code as of stage 4c (2026-10-18) by the engineering team; not reviewed
> by counsel. Every statement here should stay true of the code: if the code changes, this file changes in the same
> pull request. Items marked `[[...]]` are for Minte to fill in.

# Data flows

What data pleatkit handles, where it goes, and who can see it. Three deployments exist; the flows are the same, only
who operates each box changes:

| Deployment | The customer runs | pleatkit (the company) runs |
|---|---|---|
| Open source / self-hosted | the app, the agent server, store-server, the model key | nothing |
| pleatkit Cloud | the app (and their backend that mints user tokens) | the agent server, store-server, the model key [[confirm: managed mode only after the Anthropic sales question, V1 §2]] |
| Hybrid | the app and the agent server with their own model key | store-server |

## The pieces

```
end user's browser ──(1)──▶ agent server ──(3)──▶ model provider (Anthropic / OpenAI-compatible)
        │  ▲                     │
        │  └──────(2)────────────┤
        ▼                        ▼
   store-server ◀───────(4)──────┘          customer's backend ──(5)──▶ browser (user token)
        │
        └──(6)──▶ alert webhook / e-mail API (configured by the operator)
```

1. **Browser → agent server** (`POST /agent/v1/run`, `/v1/compile`). Per edit request:
   - the request text the user typed, and their answer to a clarifying question;
   - the current code of the customizable panels (the "dynamic zone") of that user;
   - the panel the user pointed at (an id), and its **DOM structure** without text and without field values:
     `[text:N]` placeholders (`packages/runtime/src/dom-context.ts`). With `sendDomText: true` (off by default)
     the visible text is sent with e-mail addresses and numbers masked; elements marked `data-pleatkit-private`
     and input values are never sent;
   - screenshots, only when the user attaches them (at most 3, each at most 6 MB);
   - the user token (`Authorization: Bearer …`), which says who the user and the app are.
   The context the static rules use, the read-only sources and the type definitions come from the server's copy of
   the build manifest (`PLEATKIT_MANIFEST`), not from the browser.
2. **Agent server → browser**: the edited panel code, a summary, the tool log, a signed compiled bundle (or its key).
3. **Agent server → model provider**. Two calls per edit in the usual case:
   - the classifier (a small model, `claude-haiku-5-5` by default): the request text and a short description of the
     zone; returns a label, a closed-list intent label and a gist of at most 12 words;
   - the main loop (`claude-sonnet-5-5` by default): the instructions, the read-only sources and type definitions of
     the app (cached), the panel code, the request, the DOM structure and screenshots as above.
   The weekly digest makes one more classifier call over the week's requests the panels could not serve (request
   text or gist, panel id, kind) to group them into themes (C9). `pleatkit carry-over` sends a user's old and new
   panel code to the main model when the release changed the same files.
   **Not sent:** the customer's business data from their own APIs (the panels fetch it in the browser; the agent
   sees only types and code), field values, cookies, passwords, the user token, the app key.
4. **Agent server → store-server** (server to server, the app key): the request log (text, target, verdict,
   summary, proposed files, tool log, token usage and cost, sizes of the attachments; **screenshots are not
   stored**), usage events, quota buckets, signed bundles, freezes of abusive users.
   **Browser → store-server** (`HttpStore`, the user token): the user's versions (snapshots of the panel code),
   which one is current (the head), and the link between a request and the version it produced.
5. **Customer's backend → browser**: a user token (HS256, at most 15 minutes) with the user id, the organization,
   the app, the environment and the role (`user`, `support`, `admin`). The secret stays on the customer's server.
6. **Agent server → alert channel** (only when the operator configures `PLEATKIT_ALERT_WEBHOOK` or
   `PLEATKIT_ALERT_EMAIL_*`): alert titles with the app id, the user id, the request id and the rule that was hit;
   the weekly digest (counts, organization ids, wish themes with their titles). No panel code, no request text
   except the wish themes' titles.

## What store-server keeps

| Data | Layer (DECISIONS 44) | Who can read it |
|---|---|---|
| Snapshots (the panel code of every version of every user), heads | tenant | the user (their own), support (acting as the user, audited), admin |
| Request log: text, target, proposed files, tool log, usage, cost | tenant (L0) | admin and support of the app |
| Request facts: intent label, verdict, counts, cost, keyed ids (HMAC with a per-app salt), no text, no code | tenant (L1) | the app's operator; written only in the managed cloud (the `@pleatkit/store-cloud` module; the open store has no such table) and only when the app's `learning` flag allows |
| Usage events (`edit.requested`, `tokens.used`, `cost.usd`...) | tenant | admin, support |
| Audit chain (every write, every admin action, every impersonated call), append-only, hash-linked | tenant | admin, support; exported with the app |
| Wish maps (themes with request ids), release runs, flags, plan, settings | tenant | admin, support |
| Compiled bundles of edits | public by an unguessable content key (sha256), so `<script>` can load them | anyone who knows the key |

There is no cross-tenant store (L2) in the code. Telemetry from the library is off unless a collector URL is
configured (`PLEATKIT_TELEMETRY_URL`), and never carries paths, code or user data (README, "Telemetry").

## Where it is

- Every row carries `region` and `environment` (`PLEATKIT_REGION`, `PLEATKIT_ENVIRONMENT`). One store-server
  process is one region; there is no replication between regions in the code.
- pleatkit Cloud hosting region(s): [[provider and region, e.g. EU]].
- The model provider processes requests in its own infrastructure; see [subprocessors.md](subprocessors.md).

## Export and deletion

- `pleatkit export --store <url> --app <id> [--user <id>]` (`GET /v1/admin/export`): every snapshot with its files,
  heads, requests, events, and for an app also the audit chain, flags, settings and plan, as one JSON file.
- Retention: [retention.md](retention.md). Deleting a user's or an app's data entirely is a manual operation by an
  operator today (no API) [[decide: deletion API before the first paid customer]].
