> **Draft, for the lawyer.** Written from the code as of stage 4c (2026-10-18); not reviewed by counsel. `[[...]]`
> marks what Minte fills in.

# Retention

What store-server keeps, for how long, and what deletes it. The retention job runs inside store-server every hour
(`applyRetention` in `packages/store-server/src/retention.ts`; L1 facts: the cloud module's `facts-retention` job in
`packages/store-cloud/src/learning.ts`); its periods are configuration
(`PLEATKIT_RETENTION='{"textDays": 90, "logDays": 30, "factsDays": 548}'`), the defaults below. Since 0.2 the store
is open source (MIT); L1 facts exist only in the managed cloud (the `@pleatkit/store-cloud` module), and only for
apps whose `learning` flag is on.

| Data | Kept | Then | Code |
|---|---|---|---|
| Request text, the panel the user pointed at, the gist | 90 days (`textDays`) | blanked; the row stays with its verdict, counts and cost (`retained_at` set) | `applyRetention` |
| Tool log and the files the agent proposed | 30 days (`logDays`) | blanked | `applyRetention` |
| Request facts (L1: no text, no code, keyed ids; Cloud only) | 18 months (`factsDays` = 548) | deleted | `applyFactsRetention` |
| Agent run records (idempotency of runs across instances) | 1 day | deleted | `applyRetention` |
| Idempotency records of store writes | 24 hours | ignored (replays stop), cleaned with them | `idempotency.ts` |
| Snapshots and heads (every version of every user's panels) | as long as the app uses pleatkit | deleted with the user or the app (erasure, below) | `erase.ts` |
| Usage events (metering) | as long as the app uses pleatkit | append-only (triggers refuse update and delete) except for an erasure: a user's events go with the user, all events with the app | `schema.ts` `ERASURE_TRIGGERS` |
| Audit chain | as long as the app uses pleatkit | append-only; removed only with the whole app; an erasure leaves a tombstone without personal data | `schema.ts` `ERASURE_TRIGGERS` |
| Wish maps, release runs, flags, plan, settings | as long as the app uses pleatkit | overwritten or removed with the app | — |
| Compiled bundles | as long as the app uses pleatkit | rebuilt from snapshots when missing | — |
| Screenshots attached to a request | not stored (only their count and size) | — | `requests.attachments` |
| Backups of the database (Cloud) | [[e.g. 30 days, rolling]] | [[deleted by the hosting provider's lifecycle]] | operations |

## Deleting data (erasure, DECISIONS 70.2)

An admin of the app erases through the API or the CLI. Both take two steps: the first call deletes nothing and
answers with what would go (row counts per table) and a confirm token for exactly that state; the second, with the
token, deletes everything in one database transaction. If the data changed in between, the token no longer matches
and nothing is deleted.

```bash
npx pleatkit erase --user <user id> --app <app id> --store <url>     # prints the counts and the token
npx pleatkit erase --user <user id> --app <app id> --store <url> --confirm <token>
npx pleatkit erase --app <app id> --store <url> [--confirm <token>]   # the whole app
```

(`DELETE /v1/admin/users/:id?confirm=` and `DELETE /v1/admin/apps/:id?confirm=`; the app key or a user token with
role `admin`; support gets 403; erasing while acting as a user is refused.)

- **A user** (data subject request, or the user leaves the customer): their snapshots and heads, their requests (text,
  tool logs, proposed files), usage events of the user or of their requests, the browser-made bundles they own and
  the signed bundles compiled from their files (by the files' hash; the app's original release, shared by every
  user, stays), agent-run records, stored idempotent replies, quota buckets, user-scoped flags, carry-over rows,
  their request ids in wish maps (themes made only of their requests are removed), and in the Cloud their L1 facts
  (by request and by the user's HMAC key).
- **A customer** leaves (Cloud): they first export everything (`pleatkit export --app <id>`, one JSON file with every
  version and the audit chain), then the app is erased: every row of every table with its app id, the audit chain,
  plan, settings, flags, and in the Cloud the L1 facts, the HMAC salt and the learning setting. Backups age out
  within [[backup retention]]. See the MSA draft, "Exit".
- **The tombstone.** Each erasure appends one row to the app's audit chain: action `erase.user` or `erase.app`, the
  admin who did it, the row counts and a random id (`erased:<16 hex>`), and nothing that identifies the subject. The
  API and the CLI print the id so it can be kept with the request. After an app erasure the tombstone is the first
  row of a new chain.
- **What a user erasure keeps.** The app's audit chain is hash-linked across all users, so its earlier rows stay as
  they are, including the rows that name the erased user's id as actor or object (ids from the customer's system;
  no request text, no code). [[Counsel: is keeping these rows covered by the accountability exemption, or must
  the chain be made redactable (a separate decision; it changes the chain format)?]] Aggregates already sent
  elsewhere (an invoice, an exported CSV report) are not recalled.
- The append-only tables (events, audit) accept a DELETE only inside an erasure (a marker row the erasure writes and
  removes in its own transaction); single audit rows are never removed, which is how a customer verifies that nobody
  edited their audit log.

## Model provider

What the model provider retains of the requests it processed is governed by its terms, not by store-server:
[[from the Anthropic agreement]]. pleatkit sends each request once and does not ask the provider to store it.
