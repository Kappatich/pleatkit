> **Draft, for the lawyer.** Written from the code as of stage 4c (2026-10-18); not reviewed by counsel. `[[...]]`
> marks what Minte fills in.

# Retention

What store-server keeps, for how long, and what deletes it. The retention job runs inside store-server every hour
(`applyRetention`, `packages/store-server/src/facts.ts`); its periods are configuration
(`PLEATKIT_RETENTION='{"textDays": 90, "logDays": 30, "factsDays": 548}'`), the defaults below.

| Data | Kept | Then | Code |
|---|---|---|---|
| Request text, the panel the user pointed at, the gist | 90 days (`textDays`) | blanked; the row stays with its verdict, counts and cost (`retained_at` set) | `applyRetention` |
| Tool log and the files the agent proposed | 30 days (`logDays`) | blanked | `applyRetention` |
| Request facts (L1: no text, no code, keyed ids) | 18 months (`factsDays` = 548) | deleted | `applyRetention` |
| Agent run records (idempotency of runs across instances) | 1 day | deleted | `applyRetention` |
| Idempotency records of store writes | 24 hours | ignored (replays stop), cleaned with them | `idempotency.ts` |
| Snapshots and heads (every version of every user's panels) | as long as the app uses pleatkit | deleted with the user or the app by an operator | — |
| Usage events, audit chain | as long as the app uses pleatkit | append-only by design (triggers refuse update and delete); removed only with the whole app's data | `schema.ts` triggers |
| Wish maps, release runs, flags, plan, settings | as long as the app uses pleatkit | overwritten or removed with the app | — |
| Compiled bundles | as long as the app uses pleatkit | rebuilt from snapshots when missing | — |
| Screenshots attached to a request | not stored (only their count and size) | — | `requests.attachments` |
| Backups of the database (Cloud) | [[e.g. 30 days, rolling]] | [[deleted by the hosting provider's lifecycle]] | operations |

## Deleting data

- **A user** leaves the customer: today an operator deletes their snapshots, heads and requests (SQL on the
  store database; the audit chain keeps the record that the deletion happened). [[Decide: a `DELETE /v1/admin/users/:id`
  endpoint before the first paid customer.]]
- **A customer** leaves (Cloud): they first export everything (`pleatkit export --app <id>`, one JSON file with
  every version and the audit chain), then pleatkit deletes the app's rows and its backups age out within
  [[backup retention]]. See the MSA draft, "Exit".
- The append-only tables (events, audit) can only be removed as a whole for an app: removing single rows would break
  the hash chain, which is how a customer verifies that nobody edited their audit log.

## Model provider

What the model provider retains of the requests it processed is governed by its terms, not by store-server:
[[from the Anthropic agreement]]. pleatkit sends each request once and does not ask the provider to store it.
